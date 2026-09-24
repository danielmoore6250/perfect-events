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
let calendarToken;

beforeEach(() => {
  clearSession();
  localStorage.clear();
  window.history.replaceState(null, '', '/admin');
  window.scrollTo = jest.fn();
  requests = [];
  store = { [booking.id]: { ...booking }, [pastBooking.id]: { ...pastBooking } };
  calendarToken = 'tok_original_000000000000000000';

  global.fetch = jest.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, body, headers: init.headers || {} });

    if (url === `${API_BASE}/admin/config`) {
      return jsonResponse(200, { region: 'eu-west-1', userPoolId: 'eu-west-1_X', clientId: 'client123' });
    }

    if (url.startsWith('https://cognito-idp.')) {
      const target = init.headers['X-Amz-Target'].split('.').pop();
      if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
        throw new TypeError('Failed to fetch');
      }
      if (target === 'InitiateAuth') {
        if (body.AuthParameters.PASSWORD === 'wrong') {
          return jsonResponse(400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
        }
        if (body.AuthParameters.PASSWORD === 'temporary') {
          return jsonResponse(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1' });
        }
        return jsonResponse(200, { AuthenticationResult: { IdToken: 'id-token', RefreshToken: 'refresh', ExpiresIn: 3600 } });
      }
      if (target === 'RespondToAuthChallenge') {
        return jsonResponse(200, { AuthenticationResult: { IdToken: 'id-token-2', RefreshToken: 'refresh', ExpiresIn: 3600 } });
      }
      if (target === 'ForgotPassword') {
        return jsonResponse(200, { CodeDeliveryDetails: { Destination: 'a***@e***', DeliveryMedium: 'EMAIL' } });
      }
      if (target === 'ConfirmForgotPassword') {
        if (body.ConfirmationCode !== '123456') {
          return jsonResponse(400, { __type: 'CodeMismatchException', message: 'Invalid verification code provided' });
        }
        return jsonResponse(200, {});
      }

    }

    if (url.startsWith(`${API_BASE}/admin/calendar`)) {
      if (init.headers.Authorization !== 'Bearer id-token') return jsonResponse(401, { message: 'Unauthorized' });
      if (method === 'POST' && url.endsWith('/rotate')) calendarToken = 'tok_rotated_0000000000000000000';
      return jsonResponse(200, { calendar: { token: calendarToken, rotatedAt: '2026-09-24T10:00:00.000Z' } });
    }

    if (url.startsWith(`${API_BASE}/admin/bookings`)) {
      if (init.headers.Authorization !== 'Bearer id-token' && init.headers.Authorization !== 'Bearer id-token-2') {
        return jsonResponse(401, { message: 'Unauthorized' });
      }
      if (method === 'POST' && url === `${API_BASE}/admin/bookings`) {
        if (!body.name) return jsonResponse(400, { error: 'A client name is required' });
        const created = {
          id: 'new-0000-0000', recordType: 'booking', source: 'admin', status: body.status || 'booked',
          createdAt: '2026-09-24T20:00:00.000Z', updatedAt: '2026-09-24T20:00:00.000Z',
          eventDate: body.eventDate || 'unknown',
          client: { name: body.name, email: body.email || '', phone: body.phone || '' },
          event: { type: body.eventType || null, weddingPackage: body.weddingPackage || null, venue: body.venue || null, guestCount: body.guestCount || null },
          pricing: body.pricing ? { quote: Number(body.pricing.quote), deposit: body.pricing.deposit ? Number(body.pricing.deposit) : null, depositPaidOn: body.pricing.depositPaidOn || null, balancePaidOn: null } : undefined,
          notes: body.notes || null,
          statusHistory: [{ status: body.status || 'booked', at: '2026-09-24T20:00:00.000Z', by: 'admin@example.com' }],
          planningToken: 'tok_created_00000000000000000000'
        };
        store[created.id] = created;
        return jsonResponse(201, { booking: created });
      }
      if (method === 'POST' && url.endsWith('/planning-link')) {
        const id = decodeURIComponent(url.slice(`${API_BASE}/admin/bookings/`.length, -'/planning-link'.length));
        const current = store[id];
        const token = body.regenerate || !current.planningToken ? `tok_${(current.planningToken ? 'new' : 'first')}_000000000000000000000` : current.planningToken;
        store[id] = { ...current, planningToken: token };
        return jsonResponse(200, { booking: store[id] });
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
        const { expectedUpdatedAt, ...fields } = body;
        if (expectedUpdatedAt !== current.updatedAt) {
          return jsonResponse(409, { error: 'Booking changed since it was loaded. Reload and try again.' });
        }
        const next = { ...current, ...fields, updatedAt: '2026-09-23T09:00:00.000Z' };
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
    pricing: { quote: '1250', deposit: '250', depositPaidOn: null, balancePaidOn: null },
    expectedUpdatedAt: booking.updatedAt
  });

  const history = screen.getByRole('list');
  expect(within(history).getAllByRole('listitem')).toHaveLength(2);
  expect(within(history).getByText('admin@example.com', { exact: false })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // The row's name is a real link, so keyboard and assistive tech get native semantics.
  fireEvent.click(screen.getByRole('button', { name: '← All bookings' }));
  expect(await screen.findByRole('link', { name: 'Aoife Murphy' })).toHaveAttribute('href', `/admin/${booking.id}`);
});

test('a stale save is reported and the record can be reloaded', async () => {
  render(<AdminApp />);
  await signIn();
  fireEvent.click(await screen.findByText('Aoife Murphy'));
  await screen.findByRole('heading', { name: 'Aoife Murphy' });

  // Someone else saves in the meantime.
  store[booking.id] = { ...store[booking.id], notes: 'from another tab', updatedAt: '2026-09-23T08:00:00.000Z' };

  fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'quoted' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('changed since it was loaded');
  expect(store[booking.id].status).toBe('enquiry');
});

test('forgot password emails a code, rejects a wrong code, then signs in with the new password', async () => {
  render(<AdminApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'Forgot password?' }));

  expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a reset code' }));

  expect(await screen.findByRole('heading', { name: 'Enter the reset code' })).toBeInTheDocument();
  expect(screen.getByText(/a reset code is on its way/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Reset code'), { target: { value: '000000' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Reset-Pass-Word-1' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Reset-Pass-Word-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right');

  fireEvent.change(screen.getByLabelText('Reset code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));

  expect(await screen.findByText('Aoife Murphy')).toBeInTheDocument();
  const confirm = requests.find((r) => r.headers['X-Amz-Target']?.endsWith('ConfirmForgotPassword') && r.body.ConfirmationCode === '123456');
  expect(confirm.body.Password).toBe('Reset-Pass-Word-1');
});

test('a refresh that fails on the network keeps the session and reports the problem', async () => {
  localStorage.setItem(
    'pe-admin-session',
    JSON.stringify({ email: 'admin@example.com', idToken: 'expired', refreshToken: 'refresh', expiresAt: Date.now() - 1000 })
  );
  render(<AdminApp />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh your session');
  expect(screen.queryByRole('heading', { name: 'Admin sign in' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('pe-admin-session')).refreshToken).toBe('refresh');
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

test('an empty list explains what is hidden and offers to show it', async () => {
  store = { [pastBooking.id]: { ...pastBooking } };
  render(<AdminApp />);
  await signIn();

  expect(await screen.findByText('No bookings match.')).toBeInTheDocument();
  expect(screen.getByText(/1 booking in other stages/)).toBeInTheDocument();
  expect(screen.queryByText(/hidden because the date has passed/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show every stage' }));
  expect(await screen.findByText(/1 booking hidden because the date has passed/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show past dates' }));
  expect(await screen.findByText('Old Client')).toBeInTheDocument();
  expect(screen.getByLabelText('Include past dates')).toBeChecked();
});

test('a brand new account sees a friendly empty message', async () => {
  store = {};
  render(<AdminApp />);
  await signIn();
  expect(await screen.findByText(/No bookings yet/)).toBeInTheDocument();
});

test('the calendar page shows the feed link, copies it, and can rotate it', async () => {
  const writeText = jest.fn().mockResolvedValue();
  Object.assign(navigator, { clipboard: { writeText } });
  window.confirm = jest.fn(() => true);

  render(<AdminApp />);
  await signIn();
  await screen.findByText('Aoife Murphy');
  fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));

  expect(await screen.findByRole('heading', { name: 'Bookings in your calendar' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/admin/calendar');
  const expectedUrl = `${API_BASE}/calendar/tok_original_000000000000000000.ics`;
  expect(await screen.findByText(expectedUrl)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(writeText).toHaveBeenCalledWith(expectedUrl);
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Generate a new link' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(await screen.findByText(`${API_BASE}/calendar/tok_rotated_0000000000000000000.ics`)).toBeInTheDocument();
  expect(requests.some((r) => r.method === 'POST' && r.url === `${API_BASE}/admin/calendar/rotate`)).toBe(true);
});

test('declining the rotate confirmation leaves the link alone', async () => {
  window.confirm = jest.fn(() => false);
  window.history.replaceState(null, '', '/admin/calendar');
  render(<AdminApp />);
  await signIn();

  await screen.findByText(`${API_BASE}/calendar/tok_original_000000000000000000.ics`);
  fireEvent.click(screen.getByRole('button', { name: 'Generate a new link' }));
  expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/rotate'))).toBe(false);
});

test('the planning card creates a link, shows it, and regenerates it on confirm', async () => {
  const writeText = jest.fn().mockResolvedValue();
  Object.assign(navigator, { clipboard: { writeText } });
  window.confirm = jest.fn(() => true);

  render(<AdminApp />);
  await signIn();
  fireEvent.click(await screen.findByText('Aoife Murphy'));
  await screen.findByRole('heading', { name: 'Aoife Murphy' });

  expect(screen.getByText(/No link yet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create planning link' }));

  const expectedUrl = `${window.location.origin}/plan/tok_first_000000000000000000000`;
  expect(await screen.findByText(expectedUrl)).toBeInTheDocument();
  expect(screen.getByText('Not filled in yet.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(writeText).toHaveBeenCalledWith(expectedUrl);

  fireEvent.click(screen.getByRole('button', { name: 'New link' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(await screen.findByText(`${window.location.origin}/plan/tok_new_000000000000000000000`)).toBeInTheDocument();
  const regen = requests.find((r) => r.method === 'POST' && r.url.endsWith('/planning-link') && r.body.regenerate === true);
  expect(regen).toBeTruthy();
});

test("the planning card shows the client's answers once submitted", async () => {
  store[booking.id] = {
    ...store[booking.id],
    planningToken: 'tok_existing_0000000000000000000',
    planning: {
      answers: { djStartTime: '19:30', firstDance: 'Perfect – Ed Sheeran', doNotPlay: 'Cha Cha Slide\nMacarena' },
      submittedAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-26T11:00:00.000Z'
    }
  };
  render(<AdminApp />);
  await signIn();
  fireEvent.click(await screen.findByText('Aoife Murphy'));
  await screen.findByRole('heading', { name: 'Aoife Murphy' });

  expect(screen.getByText(/Filled in .*last changed/)).toBeInTheDocument();
  expect(screen.getByText('DJ starts')).toBeInTheDocument();
  expect(screen.getByText('19:30')).toBeInTheDocument();
  expect(screen.getByText('First dance')).toBeInTheDocument();
  expect(screen.getByText('Perfect – Ed Sheeran')).toBeInTheDocument();
  expect(screen.getByText(/Cha Cha Slide/)).toBeInTheDocument();
  expect(screen.queryByText('Not filled in yet.')).not.toBeInTheDocument();
});

test('the planning card renders picked songs with artwork, an Open link, and copies them as text', async () => {
  const writeText = jest.fn().mockResolvedValue();
  Object.assign(navigator, { clipboard: { writeText } });
  store[booking.id] = {
    ...store[booking.id],
    planningToken: 'tok_existing_0000000000000000000',
    planning: {
      answers: {
        firstDance: [{ source: 'apple', id: '100', title: 'Perfect', artist: 'Ed Sheeran', album: '÷', artwork: 'https://is1-ssl.mzstatic.com/100/300x300bb.jpg', previewUrl: 'https://audio-ssl.itunes.apple.com/100.m4a', url: 'https://music.apple.com/gb/album/x/100', durationMs: 263000 }],
        mustPlay: [
          { source: 'deezer', id: '9', title: 'Boston', artist: 'Augustana', album: null, artwork: null, previewUrl: null, url: 'https://www.deezer.com/track/9', durationMs: null },
          { source: 'manual', id: null, title: 'Our song', artist: '', album: null, artwork: null, previewUrl: null, url: null, durationMs: null }
        ],
        doNotPlay: 'Cha Cha Slide',
        namedDances: [{ name: 'Father and daughter', song: { source: 'apple', id: '7', title: 'My Girl', artist: 'The Temptations', album: null, artwork: null, previewUrl: null, url: 'https://music.apple.com/gb/album/x/7', durationMs: null } }, { name: 'Groom and mother', song: null }],
        playlistLinks: [{ url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', provider: 'spotify', title: 'Our wedding vibes', thumbnail: null }],
        guestCount: 120
      },
      submittedAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:00:00.000Z'
    }
  };
  render(<AdminApp />);
  await signIn();
  fireEvent.click(await screen.findByText('Aoife Murphy'));
  await screen.findByRole('heading', { name: 'Aoife Murphy' });

  const lists = screen.getAllByRole('list').filter((l) => l.className.includes('songlist'));
  expect(lists).toHaveLength(4); // first dance, other dances, playlist links, must play

  const first = within(lists[0]);
  expect(first.getByText('Perfect')).toBeInTheDocument();
  expect(first.getByText('Ed Sheeran')).toBeInTheDocument();
  expect(lists[0].querySelector('img')).toHaveAttribute('src', 'https://is1-ssl.mzstatic.com/100/300x300bb.jpg');
  expect(first.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://music.apple.com/gb/album/x/100');

  const dances = within(lists[1]);
  expect(dances.getByText('Father and daughter')).toBeInTheDocument();
  expect(dances.getByText('The Temptations – My Girl')).toBeInTheDocument();
  expect(dances.getByText('Groom and mother')).toBeInTheDocument();
  expect(dances.getByText('Song to be confirmed')).toBeInTheDocument();

  const must = within(lists[3]);
  expect(must.getByText('Boston')).toBeInTheDocument();
  expect(must.getByText('Our song')).toBeInTheDocument();
  expect(must.getByText('Typed in by the client')).toBeInTheDocument();
  expect(must.getAllByRole('link', { name: 'Open' })).toHaveLength(1);

  // Legacy text still shows as text.
  expect(screen.getByText('Cha Cha Slide')).toBeInTheDocument();

  // The client's updated guest count replaces the enquiry number, with the original noted.
  expect(screen.getByText('(was 150 on the enquiry)', { exact: false })).toBeInTheDocument();

  // The admin can preview a picked song; playback streams through the preview route.
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  fireEvent.click(first.getByRole('button', { name: 'Preview Perfect' }));
  expect(window.HTMLMediaElement.prototype.play.mock.instances[0].src).toBe(`${API_BASE}/music/preview?source=apple&id=100`);
  expect(await first.findByRole('button', { name: 'Stop preview of Perfect' })).toBeInTheDocument();
  expect(must.queryByRole('button', { name: /Preview Our song/ })).not.toBeInTheDocument();

  // Shared playlist links show with an Open link.
  const playlistOpen = screen.getAllByRole('link', { name: 'Open' }).find((a) => a.getAttribute('href').includes('spotify'));
  expect(playlistOpen).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Our wedding vibes' })).toHaveAttribute('href', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');

  fireEvent.click(screen.getByRole('button', { name: 'Copy song lists as text' }));
  expect(writeText).toHaveBeenCalledWith('First dance\nEd Sheeran – Perfect\n\nOther dances\nFather and daughter: The Temptations – My Girl\nGroom and mother: song to be confirmed\n\nPlaylists you love\nOur wedding vibes (Spotify) https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M\n\nMust play\nAugustana – Boston\nOur song\n\nDo not play\nCha Cha Slide');
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

test('the admin can create a booking by hand and lands on its page with a planning link ready', async () => {
  render(<AdminApp />);
  await signIn();
  await screen.findByText('Aoife Murphy');
  fireEvent.click(screen.getByRole('button', { name: 'New booking' }));

  expect(await screen.findByRole('heading', { name: 'New booking' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/admin/new');
  const create = screen.getByRole('button', { name: 'Create booking' });
  expect(create).toBeDisabled();

  fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Ciara & Tom' } });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '07700 900999' } });
  fireEvent.change(screen.getByLabelText('Package'), { target: { value: 'after-band' } });
  fireEvent.change(screen.getByLabelText(/^Event date/), { target: { value: '2027-08-14' } });
  fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'Clandeboye Lodge' } });
  fireEvent.change(screen.getByLabelText('Guests'), { target: { value: '180' } });
  fireEvent.change(screen.getByLabelText('Quote (£)'), { target: { value: '1100' } });
  fireEvent.change(screen.getByLabelText('Deposit (£)'), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Booked over the phone' } });
  expect(create).toBeEnabled();
  fireEvent.click(create);

  expect(await screen.findByRole('heading', { name: 'Ciara & Tom' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/admin/new-0000-0000');
  expect(screen.getByText(`${window.location.origin}/plan/tok_created_00000000000000000000`)).toBeInTheDocument();

  const post = requests.find((r) => r.method === 'POST' && r.url === `${API_BASE}/admin/bookings`);
  expect(post.body).toEqual({
    name: 'Ciara & Tom', email: '', phone: '07700 900999', eventType: 'wedding', weddingPackage: 'after-band',
    eventDate: '2027-08-14', venue: 'Clandeboye Lodge', guestCount: '180', status: 'booked', notes: 'Booked over the phone',
    pricing: { quote: '1100', deposit: '300', depositPaidOn: null, balancePaidOn: null }
  });
});

test('the new booking form hides the package for non-weddings and shows server errors', async () => {
  window.history.replaceState(null, '', '/admin/new');
  render(<AdminApp />);
  await signIn();
  await screen.findByRole('heading', { name: 'New booking' });
  expect(screen.getByLabelText('Package')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'corporate' } });
  expect(screen.queryByLabelText('Package')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'X' } });
  global.fetch.mockImplementationOnce(async () => jsonResponse(400, { error: 'eventDate must be YYYY-MM-DD or "unknown"' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create booking' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('eventDate must be');
  expect(screen.getByLabelText('Client name')).toHaveValue('X');
});
