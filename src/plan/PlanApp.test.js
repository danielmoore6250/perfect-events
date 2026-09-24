// Walks the client planning page against a mocked network: a good link, a bad
// link, the song picker (search, preview, manual entry, playlist import,
// limits), sending, editing again, legacy text, and the locked state.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PlanApp from './PlanApp';
import { API_BASE } from '../config';
import { stopPreview } from './preview';

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

const song = (id, title, artist, extra = {}) => ({
  source: 'apple',
  id: String(id),
  title,
  artist,
  album: `${title} (Single)`,
  artwork: `https://is1-ssl.mzstatic.com/${id}/300x300bb.jpg`,
  previewUrl: `https://audio-ssl.itunes.apple.com/${id}.m4a`,
  durationMs: 263000,
  url: `https://music.apple.com/gb/album/x/${id}`,
  ...extra
});

const CATALOGUE = [song(100, 'Perfect', 'Ed Sheeran'), song(101, 'Perfect Symphony', 'Ed Sheeran & Andrea Bocelli'), song(200, 'Mr Brightside', 'The Killers')];

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let current;
let posts;
let searches;

beforeEach(() => {
  window.scrollTo = jest.fn();
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  stopPreview();
  current = view();
  posts = [];
  searches = [];

  global.fetch = jest.fn(async (url, init = {}) => {
    if (url.startsWith(`${API_BASE}/music/search`)) {
      const q = new URL(url).searchParams.get('q').toLowerCase();
      searches.push(q);
      return jsonResponse(200, { source: 'apple', songs: CATALOGUE.filter((s) => s.title.toLowerCase().includes(q)) });
    }
    if (url.startsWith(`${API_BASE}/music/playlist`)) {
      const link = new URL(url).searchParams.get('url');
      if (link.includes('spotify')) return jsonResponse(400, { error: 'Spotify playlists cannot be imported.' });
      return jsonResponse(200, { source: 'apple', songs: [song(300, 'Dancing Queen', 'ABBA'), song(200, 'Mr Brightside', 'The Killers')] });
    }
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

const picker = (label) => within(screen.getByRole('group', { name: label }));

const searchIn = (label, text) => fireEvent.change(picker(label).getByLabelText(`Search songs for ${label}`), { target: { value: text } });

test('greets the client by first name with their event details and wedding-only pickers', async () => {
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('heading', { name: "Hi Aoife, let's plan your wedding" })).toBeInTheDocument();
  expect(screen.getByText(/Friday 12 June 2099 · Galgorm Resort · Full night/)).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'First dance' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Play if possible' })).toBeInTheDocument();
  expect(screen.getByLabelText('Speeches')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();
});

test('a corporate event hides the wedding-only fields', async () => {
  current = view({ eventType: 'corporate', eventTypeLabel: 'corporate event', weddingPackage: null });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('heading', { name: "Hi Aoife, let's plan your corporate event" });
  expect(screen.queryByRole('group', { name: 'First dance' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Speeches')).not.toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Last song of the night' })).toBeInTheDocument();
});

test('a bad link shows a clear message and never renders the form', async () => {
  visit('/plan/not-a-real-token');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'First dance' })).not.toBeInTheDocument();
});

test('a malformed path is treated as a bad link without calling the API', async () => {
  visit('/plan/');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('searching shows results with a preview, adding a song fills the list, and a single-song list closes the search', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });

  searchIn('First dance', 'perf');
  const addPerfect = await picker('First dance').findByRole('button', { name: 'Add Perfect by Ed Sheeran' });
  expect(picker('First dance').getByRole('button', { name: 'Add Perfect Symphony by Ed Sheeran & Andrea Bocelli' })).toBeInTheDocument();
  expect(searches).toEqual(['perf']);

  // Preview toggles through the shared player.
  fireEvent.click(picker('First dance').getByRole('button', { name: 'Preview Perfect' }));
  expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  expect(await picker('First dance').findByRole('button', { name: 'Stop preview of Perfect' })).toBeInTheDocument();

  fireEvent.click(addPerfect);
  expect(picker('First dance').getByRole('button', { name: 'Remove Perfect' })).toBeInTheDocument();
  // max 1: the search box is gone until the song is removed
  expect(picker('First dance').queryByLabelText('Search songs for First dance')).not.toBeInTheDocument();
  expect(picker('First dance').getByText('Remove it to choose a different song.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeEnabled();

  fireEvent.click(picker('First dance').getByRole('button', { name: 'Remove Perfect' }));
  expect(picker('First dance').getByLabelText('Search songs for First dance')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();
});

test('search is debounced and only the last query is sent', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });
  searchIn('Must play', 'm');
  searchIn('Must play', 'mr');
  searchIn('Must play', 'mr b');
  await picker('Must play').findByRole('button', { name: 'Add Mr Brightside by The Killers' });
  expect(searches).toEqual(['mr b']);
});

test('a song the catalogue does not have can be typed in', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Do not play' });
  const dnp = picker('Do not play');
  fireEvent.click(dnp.getByRole('button', { name: "Can't find it? Type it in" }));
  fireEvent.change(dnp.getByLabelText('Song title for Do not play'), { target: { value: 'Our terrible song' } });
  fireEvent.change(dnp.getByLabelText('Artist for Do not play'), { target: { value: 'Uncle Pat' } });
  fireEvent.click(dnp.getByRole('button', { name: 'Add' }));

  expect(dnp.getByText('Our terrible song')).toBeInTheDocument();
  expect(dnp.getByText('Uncle Pat')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].answers.doNotPlay).toEqual([
    { source: 'manual', id: null, title: 'Our terrible song', artist: 'Uncle Pat', album: null, artwork: null, previewUrl: null, url: null, durationMs: null }
  ]);
});

test('a playlist link imports its songs into Must play, skipping ones already there', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });
  const must = picker('Must play');

  searchIn('Must play', 'bright');
  fireEvent.click(await must.findByRole('button', { name: 'Add Mr Brightside by The Killers' }));

  fireEvent.change(must.getByLabelText('Playlist link to import into Must play'), { target: { value: 'https://music.apple.com/gb/playlist/x/pl.u-abc' } });
  fireEvent.click(must.getByRole('button', { name: 'Import playlist' }));

  expect(await must.findByText('Added 1 song.')).toBeInTheDocument();
  expect(must.getByRole('button', { name: 'Remove Dancing Queen' })).toBeInTheDocument();
  expect(must.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
  expect(must.getByText('2 / 100')).toBeInTheDocument();

  // Only Must play offers import.
  expect(picker('Do not play').queryByLabelText(/Playlist link/)).not.toBeInTheDocument();
});

test('a Spotify playlist link gets the explanation from the service', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });
  const must = picker('Must play');
  fireEvent.change(must.getByLabelText('Playlist link to import into Must play'), { target: { value: 'https://open.spotify.com/playlist/abc' } });
  fireEvent.click(must.getByRole('button', { name: 'Import playlist' }));
  expect(await must.findByText('Spotify playlists cannot be imported.')).toBeInTheDocument();
});

test('sending posts the picked songs and time fields, then allows editing again', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });

  fireEvent.change(screen.getByLabelText('DJ starts'), { target: { value: '19:30' } });
  searchIn('First dance', 'perfect');
  fireEvent.click(await picker('First dance').findByRole('button', { name: 'Add Perfect by Ed Sheeran' }));

  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByRole('status')).toHaveTextContent(/Saved\. We've got your details/);

  expect(posts).toHaveLength(1);
  expect(posts[0].answers.djStartTime).toBe('19:30');
  expect(posts[0].answers.firstDance).toEqual([CATALOGUE[0]]);
  expect(posts[0].answers.mustPlay).toEqual([]);

  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toBeDisabled();

  searchIn('Last song of the night', 'bright');
  fireEvent.click(await picker('Last song of the night').findByRole('button', { name: 'Add Mr Brightside by The Killers' }));
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].answers.lastSong).toEqual([CATALOGUE[2]]);
  expect(posts[1].answers.firstDance).toEqual([CATALOGUE[0]]);
});

test('previous song picks are shown on return, and legacy typed text is editable with a switch to search', async () => {
  window.confirm = jest.fn(() => true);
  current = view({
    answers: { firstDance: 'Yellow – Coldplay', mustPlay: [song(200, 'Mr Brightside', 'The Killers')], finishTime: '00:30' },
    submittedAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z'
  });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });

  expect(picker('Must play').getByRole('button', { name: 'Remove Mr Brightside' })).toBeInTheDocument();
  expect(screen.getByLabelText('Music must finish by')).toHaveValue('00:30');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  const first = picker('First dance');
  expect(first.getByLabelText('First dance')).toHaveValue('Yellow – Coldplay');
  fireEvent.click(first.getByRole('button', { name: 'Use song search instead' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(first.getByLabelText('Search songs for First dance')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('a locked form is read-only with an explanation', async () => {
  current = view({ locked: true, answers: { firstDance: 'Yellow – Coldplay', mustPlay: [song(200, 'Mr Brightside', 'The Killers')] }, submittedAt: 'x', updatedAt: 'x' });
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('alert')).toHaveTextContent(/now locked/);
  expect(picker('First dance').getByLabelText('First dance')).toBeDisabled();
  expect(picker('Must play').queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  expect(picker('Must play').queryByLabelText(/Search songs/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Save|Send/ })).not.toBeInTheDocument();
});

test('a server error on save is shown and the answers are kept', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });
  fireEvent.change(screen.getByLabelText('Anything else we should know?'), { target: { value: 'X' } });
  global.fetch.mockImplementationOnce(async () => jsonResponse(400, { error: 'djStartTime must be a time like 19:30' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('djStartTime must be a time like 19:30');
  expect(screen.getByLabelText('Anything else we should know?')).toHaveValue('X');
});

test('a 423 on save puts the page into the locked state instead of leaving it editable', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });
  fireEvent.change(screen.getByLabelText('Anything else we should know?'), { target: { value: 'X' } });
  current = { ...current, locked: true };
  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/now locked/);
  expect(screen.getByLabelText('Anything else we should know?')).toBeDisabled();
  expect(screen.queryByRole('button', { name: /Save|Send/ })).not.toBeInTheDocument();
});

test('a search response that arrives after the text changed is discarded', async () => {
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/music/search') && url.includes('q=slow')) {
      searches.push('slow');
      await slow;
      if (init?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse(200, { source: 'apple', songs: [song(999, 'Stale result', 'Nobody')] });
    }
    return original(url, init);
  });

  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });
  searchIn('Must play', 'slow');
  await waitFor(() => expect(searches).toContain('slow'));

  // The client moves on before the slow response lands.
  searchIn('Must play', 'bright');
  await picker('Must play').findByRole('button', { name: 'Add Mr Brightside by The Killers' });
  resolveSlow();
  await new Promise((r) => setTimeout(r, 20));

  expect(picker('Must play').queryByText('Stale result')).not.toBeInTheDocument();
  expect(picker('Must play').getByRole('button', { name: 'Add Mr Brightside by The Killers' })).toBeInTheDocument();
});

test('starting a second preview while the first is still starting keeps the second marked as playing', async () => {
  let rejectFirst;
  window.HTMLMediaElement.prototype.play = jest
    .fn()
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
    .mockResolvedValue();

  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });
  searchIn('First dance', 'perf');
  await picker('First dance').findByRole('button', { name: 'Preview Perfect' });

  fireEvent.click(picker('First dance').getByRole('button', { name: 'Preview Perfect' }));
  fireEvent.click(picker('First dance').getByRole('button', { name: 'Preview Perfect Symphony' }));
  rejectFirst(new Error('interrupted'));
  await new Promise((r) => setTimeout(r, 0));

  expect(picker('First dance').getByRole('button', { name: 'Stop preview of Perfect Symphony' })).toBeInTheDocument();
  expect(picker('First dance').getByRole('button', { name: 'Preview Perfect' })).toBeInTheDocument();
});
