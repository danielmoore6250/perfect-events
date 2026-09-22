// Walks the admin screen end to end against a mocked network: sign in (both
// the normal path and the first-login new-password challenge), the list, the
// detail view, and a save that sends only the changed fields.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminApp from './AdminApp';
import { API_BASE } from '../config';
import { clearSession } from './auth';

const booking = {
  id: 'f32b20a2-1dc2-472c-a9b1-6b45ea9c5795',
  recordType: 'booking',
  status: 'enquiry',
  source: 'website',
  createdAt: '2026-09-22T18:57:42.562Z',
  updatedAt: '2026-09-22T18:57:42.562Z',
  eventDate: '2099-06-12',
  client: { name: 'Aoife Murphy', email: 'aoife@example.com', phone: '07700 900123' },
  event: { type: 'wedding', weddingPackage: 'full-night', venue: 'Galgorm Resort', guestCount: '150' },
  message: 'First dance is Perfect.',
  statusHistory: [{ status: 'enquiry', at: '2026-09-22T18:57:42.562Z', by: 'website-form' }]
};

const pastBooking = {
  ...booking,
  id: 'past-0000-0000',
  eventDate: '2020-01-01',
  status: 'completed',
  client: { name: 'Old Client', email: 'old@example.com', phone: '1' }
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

let requests;
let store;

beforeEach(() => {
  clearSession();
  localStorage.clear();
  window.history.replaceState(null, '', '/admin');
  window.scrollTo = jest.fn();
  requests = [];
  store = { [booking.id]: { ...booking }, [pastBooking.id]: { ...pastBooking } };

  global.fetch = jest.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, body, headers: init.headers || {} });

    if (url === `${API_BASE}/admin/config`) {
      return jsonResponse(200, { region: 'eu-west-1', userPoolId: 'eu-west-1_X', clientId: 'client123' });
    }

    if (url.startsWith('https://cognito-idp.')) {
      const target = init.headers['X-Amz-Target'];
      if (target.endsWith('InitiateAuth')) {
        if (body.AuthParameters.PASSWORD === 'wrong') {
          return jsonResponse(400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
        }
        if (body.AuthParameters.PASSWORD === 'temporary') {
          return jsonResponse(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1' });
        }
        return jsonResponse(200, { AuthenticationResult: { IdToken: 'id-token', RefreshToken: 'refresh', ExpiresIn: 3600 } });
      }
      if (target.endsWith('RespondToAuthChallenge')) {
        return jsonResponse(200, { AuthenticationResult: { IdToken: 'id-token-2', RefreshToken: 'refresh', ExpiresIn: 3600 } });
      }
    }

    if (url.startsWith(`${API_BASE}/admin/bookings`)) {
      if (init.headers.Authorization !== 'Bearer id-token' && init.headers.Authorization !== 'Bearer id-token-2') {
        return jsonResponse(401, { message: 'Unauthorized' });
      }
      const id = decodeURIComponent(url.slice(`${API_BASE}/admin/bookings/`.length));
      if (url === `${API_BASE}/admin/bookings`) {
        return jsonResponse(200, { bookings: Object.values(store) });
      }
      if (method === 'GET') {
        return store[id] ? jsonResponse(200, { booking: store[id] }) : jsonResponse(404, { error: 'Booking not found' });
      }
      if (method === 'PATCH') {
        const current = store[id];
        const next = { ...current, ...body, updatedAt: '2026-09-23T09:00:00.000Z' };
        if (body.status && body.status !== current.status) {
          next.statusHistory = [...current.statusHistory, { status: body.status, at: '2026-09-23T09:00:00.000Z', by: 'admin@example.com' }];
        }
        store[id] = next;
        return jsonResponse(200, { booking: next });
      }
    }

    throw new Error(`Unhandled request ${method} ${url}`);
  });
});

const signIn = async (password = 'Correct-Horse-1') => {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'admin@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
};

test('shows the login screen when there is no session and rejects a wrong password', async () => {
  render(<AdminApp />);
  expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();

  await signIn('wrong');
  expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
  expect(localStorage.getItem('pe-admin-session')).toBeNull();
});

test('signs in, lists upcoming open bookings, and hides past ones until asked', async () => {
  render(<AdminApp />);
  await signIn();

  const row = await screen.findByText('Aoife Murphy');
  expect(row).toBeInTheDocument();
  expect(screen.getByText('F32B20A2')).toBeInTheDocument();
  expect(screen.getByText('Galgorm Resort')).toBeInTheDocument();
  expect(screen.queryByText('Old Client')).not.toBeInTheDocument();
  expect(screen.getByText(/Showing 1 of 2 bookings/)).toBeInTheDocument();

  // The session is persisted for the next page load.
  expect(JSON.parse(localStorage.getItem('pe-admin-session')).idToken).toBe('id-token');

  // The bookings request carried the token.
  const list = requests.find((r) => r.url === `${API_BASE}/admin/bookings`);
  expect(list.headers.Authorization).toBe('Bearer id-token');

  fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'all' } });
  fireEvent.click(screen.getByLabelText('Include past dates'));
  expect(await screen.findByText('Old Client')).toBeInTheDocument();
  expect(screen.getByText(/Showing 2 of 2 bookings/)).toBeInTheDocument();
});

test('opens a booking, saves only the changed fields, and shows the new history entry', async () => {
  render(<AdminApp />);
  await signIn();
  fireEvent.click(await screen.findByText('Aoife Murphy'));

  expect(await screen.findByRole('heading', { name: 'Aoife Murphy' })).toBeInTheDocument();
  expect(window.location.pathname).toBe(`/admin/${booking.id}`);
  expect(screen.getByText('First dance is Perfect.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'aoife@example.com' })).toHaveAttribute('href', 'mailto:aoife@example.com');

  const saveButton = screen.getByRole('button', { name: 'Save changes' });
  expect(saveButton).toBeDisabled();

  fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'quoted' } });
  fireEvent.change(screen.getByLabelText('Quote (£)'), { target: { value: '1250' } });
  fireEvent.change(screen.getByLabelText('Deposit (£)'), { target: { value: '250' } });
  expect(screen.getByText('Balance due:')).toHaveTextContent('£1,000.00');
  expect(saveButton).toBeEnabled();

  fireEvent.click(saveButton);
  expect(await screen.findByText('Saved.')).toBeInTheDocument();

  const patch = requests.find((r) => r.method === 'PATCH');
  expect(patch.url).toBe(`${API_BASE}/admin/bookings/${booking.id}`);
  expect(patch.body).toEqual({
    status: 'quoted',
    pricing: { quote: '1250', deposit: '250', depositPaidOn: null, balancePaidOn: null }
  });

  const history = screen.getByRole('list');
  expect(within(history).getAllByRole('listitem')).toHaveLength(2);
  expect(within(history).getByText('admin@example.com', { exact: false })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('a temporary password leads to the new-password step and then into the app', async () => {
  render(<AdminApp />);
  await signIn('temporary');

  expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Brand-New-Pass-1' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Brand-New-Pass-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('do not match');

  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Brand-New-Pass-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));

  expect(await screen.findByText('Aoife Murphy')).toBeInTheDocument();
  const challenge = requests.find((r) => r.headers['X-Amz-Target']?.endsWith('RespondToAuthChallenge'));
  expect(challenge.body.ChallengeResponses).toEqual({ USERNAME: 'admin@example.com', NEW_PASSWORD: 'Brand-New-Pass-1' });
});

test('a stored session skips the login and a 401 sends the admin back to it', async () => {
  localStorage.setItem(
    'pe-admin-session',
    JSON.stringify({ email: 'admin@example.com', idToken: 'stale', refreshToken: null, expiresAt: Date.now() + 3600 * 1000 })
  );
  render(<AdminApp />);

  expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
  expect(localStorage.getItem('pe-admin-session')).toBeNull();
});

test('signing out clears the session', async () => {
  render(<AdminApp />);
  await signIn();
  await screen.findByText('Aoife Murphy');

  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument());
  expect(localStorage.getItem('pe-admin-session')).toBeNull();
});
