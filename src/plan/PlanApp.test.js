// Walks the client planning page against a mocked network: a good link, a bad
// link, filling in and sending, editing again, and the locked state.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlanApp from './PlanApp';
import { API_BASE } from '../config';

const TOKEN = 'planXYZ123_abcdefghijklmnopqrstu';

const view = (overrides = {}) => ({
  clientName: 'Aoife Murphy',
  eventDate: '2099-06-12',
  eventDateLabel: 'Friday 12 June 2099',
  eventType: 'wedding',
  eventTypeLabel: 'wedding',
  weddingPackage: 'full-night',
  venue: 'Galgorm Resort',
  guestCount: '150',
  locked: false,
  answers: {},
  submittedAt: null,
  updatedAt: null,
  ...overrides
});

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let current;
let posts;

beforeEach(() => {
  window.scrollTo = jest.fn();
  current = view();
  posts = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    if (!url.startsWith(`${API_BASE}/plan/`)) throw new Error(`Unhandled ${url}`);
    const token = url.slice(`${API_BASE}/plan/`.length);
    if (token !== TOKEN) return jsonResponse(404, { error: 'Not found' });
    if ((init.method || 'GET') === 'GET') return jsonResponse(200, { booking: current });
    const body = JSON.parse(init.body);
    posts.push(body);
    if (current.locked) return jsonResponse(423, { error: 'This form is now locked because the event is only a few days away.' });
    const now = '2026-09-25T10:00:00.000Z';
    current = { ...current, answers: body.answers, submittedAt: current.submittedAt || now, updatedAt: now };
    return jsonResponse(200, { booking: current });
  });
});

const visit = (path) => {
  window.history.replaceState(null, '', path);
  return render(<PlanApp />);
};

test('greets the client by first name with their event details and wedding-only fields', async () => {
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('heading', { name: "Hi Aoife, let's plan your wedding" })).toBeInTheDocument();
  expect(screen.getByText(/Friday 12 June 2099 · Galgorm Resort · Full night/)).toBeInTheDocument();
  expect(screen.getByLabelText('First dance')).toBeInTheDocument();
  expect(screen.getByLabelText('Speeches')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();
});

test('a corporate event hides the wedding-only fields', async () => {
  current = view({ eventType: 'corporate', eventTypeLabel: 'corporate event', weddingPackage: null });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('heading', { name: "Hi Aoife, let's plan your corporate event" });
  expect(screen.queryByLabelText('First dance')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Speeches')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Last song of the night')).toBeInTheDocument();
});

test('a bad link shows a clear message and never renders the form', async () => {
  visit('/plan/not-a-real-token');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(screen.queryByLabelText('First dance')).not.toBeInTheDocument();
});

test('a malformed path is treated as a bad link without calling the API', async () => {
  visit('/plan/');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('filling in and sending posts the answers, shows the confirmation, then allows editing again', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('First dance');

  fireEvent.change(screen.getByLabelText('DJ starts'), { target: { value: '19:30' } });
  fireEvent.change(screen.getByLabelText('First dance'), { target: { value: 'Perfect – Ed Sheeran' } });
  fireEvent.change(screen.getByLabelText('Do not play'), { target: { value: 'Cha Cha Slide' } });

  const send = screen.getByRole('button', { name: 'Send us your details' });
  expect(send).toBeEnabled();
  fireEvent.click(send);

  expect(await screen.findByRole('status')).toHaveTextContent(/Saved\. We've got your details/);
  expect(posts).toHaveLength(1);
  expect(posts[0].answers.djStartTime).toBe('19:30');
  expect(posts[0].answers.firstDance).toBe('Perfect – Ed Sheeran');
  expect(posts[0].answers.doNotPlay).toBe('Cha Cha Slide');
  expect(posts[0].answers.mustPlay).toBe('');

  // Now in "edit" mode: button renamed, disabled until something changes.
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toBeDisabled();
  expect(screen.getByText(/Last saved/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Last song of the night'), { target: { value: 'Mr Brightside' } });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].answers.lastSong).toBe('Mr Brightside');
  expect(posts[1].answers.firstDance).toBe('Perfect – Ed Sheeran');
});

test('previous answers are prefilled on return', async () => {
  current = view({ answers: { firstDance: 'Yellow – Coldplay', finishTime: '00:30' }, submittedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z' });
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByLabelText('First dance')).toHaveValue('Yellow – Coldplay');
  expect(screen.getByLabelText('Music must finish by')).toHaveValue('00:30');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('a locked form is read-only with an explanation', async () => {
  current = view({ locked: true, answers: { firstDance: 'Yellow – Coldplay' }, submittedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z' });
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('alert')).toHaveTextContent(/now locked/);
  expect(screen.getByLabelText('First dance')).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Save|Send/ })).not.toBeInTheDocument();
});

test('a server error on save is shown and the answers are kept', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('First dance');
  global.fetch.mockImplementationOnce(async () => jsonResponse(400, { error: 'djStartTime must be a time like 19:30' }));
  fireEvent.change(screen.getByLabelText('First dance'), { target: { value: 'X' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('djStartTime must be a time like 19:30');
  expect(screen.getByLabelText('First dance')).toHaveValue('X');
});
