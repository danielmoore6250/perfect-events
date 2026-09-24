// Walks the client planning page against a mocked network: a good link, a bad
// link, the song picker (search, preview, manual entry, playlist import,
// limits), sending, editing again, legacy text, and the locked state.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PlanApp from './PlanApp';
import { API_BASE } from '../config';
import { PLANNING_FIELDS } from '../shared/format';
import { stopPreview } from '../shared/preview';

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
const finder = () => screen.getByLabelText('Search for a song');
const chooseList = (label) => fireEvent.change(screen.getByLabelText('Adding to'), { target: { value: PLANNING_FIELDS.find((f) => f.label === label).key } });
const search = (text) => fireEvent.change(finder(), { target: { value: text } });
const results = () => within(screen.getByRole('list', { name: 'Search results' }));
const waitResults = () => screen.findByRole('list', { name: 'Search results' });

test('greets the client by first name with their event details and wedding-only lists', async () => {
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('heading', { name: "Hi Aoife, let's plan your wedding" })).toBeInTheDocument();
  expect(screen.getByText(/Friday 12 June 2099 · Galgorm Resort · Full night/)).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'First dance' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Play if possible' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Speeches')).toBeInTheDocument();
  expect(screen.getByLabelText('Meal served')).toBeInTheDocument();
  expect(screen.getByLabelText('Number of guests')).toHaveValue(150);
  expect(screen.getAllByLabelText('Search for a song')).toHaveLength(1);
  expect(screen.getByLabelText('Adding to')).toHaveValue('mustPlay');
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();
});

test('a corporate event keeps the meal time but hides the wedding-only fields and lists', async () => {
  current = view({ eventType: 'corporate', eventTypeLabel: 'corporate event', weddingPackage: null });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('heading', { name: "Hi Aoife, let's plan your corporate event" });
  expect(screen.queryByRole('group', { name: 'First dance' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Speeches')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Meal served')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Last song of the night' })).toBeInTheDocument();
  expect(within(screen.getByLabelText('Adding to')).queryByRole('option', { name: /First dance/ })).not.toBeInTheDocument();
});

test('a bad link shows a clear message and never renders the form', async () => {
  visit('/plan/not-a-real-token');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(screen.queryByLabelText('Search for a song')).not.toBeInTheDocument();
});

test('a malformed path is treated as a bad link without calling the API', async () => {
  visit('/plan/');
  expect(await screen.findByRole('heading', { name: "This link isn't right" })).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('the Add shortcut on a list points the search at it; adding to a one-song list fills it and closes the search', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'First dance' });

  fireEvent.click(picker('First dance').getByRole('button', { name: 'Add to First dance' }));
  expect(screen.getByLabelText('Adding to')).toHaveValue('firstDance');
  expect(finder()).toHaveFocus();

  search('perf');
  await waitResults();
  const addPerfect = results().getByRole('button', { name: 'Add Perfect by Ed Sheeran' });
  expect(results().getByRole('button', { name: 'Add Perfect Symphony by Ed Sheeran & Andrea Bocelli' })).toBeInTheDocument();
  expect(searches).toEqual(['perf']);

  // Preview toggles through the shared player, streaming via our own route so
  // the link is always fresh (stored Deezer links expire within minutes).
  const playSpy = window.HTMLMediaElement.prototype.play;
  fireEvent.click(results().getByRole('button', { name: 'Preview Perfect' }));
  expect(playSpy).toHaveBeenCalled();
  expect(playSpy.mock.instances[0].src).toBe(`${API_BASE}/music/preview?source=apple&id=100`);
  expect(await results().findByRole('button', { name: 'Stop preview of Perfect' })).toBeInTheDocument();

  fireEvent.click(addPerfect);
  expect(picker('First dance').getByRole('button', { name: 'Remove Perfect' })).toBeInTheDocument();
  expect(picker('First dance').queryByRole('button', { name: 'Add to First dance' })).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
  expect(finder()).toBeDisabled();
  expect(screen.getByText(/Remove the current first dance song/)).toBeInTheDocument();
  expect(within(screen.getByLabelText('Adding to')).getByRole('option', { name: 'First dance (full)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeEnabled();

  fireEvent.click(picker('First dance').getByRole('button', { name: 'Remove Perfect' }));
  expect(finder()).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();
});

test('search is debounced and only the last query is sent', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  search('m');
  search('mr');
  search('mr b');
  await waitResults();
  expect(searches).toEqual(['mr b']);
});

test('adding to a multi-song list keeps the results open and marks what is already added', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  search('perf');
  await waitResults();
  fireEvent.click(results().getByRole('button', { name: 'Add Perfect by Ed Sheeran' }));
  expect(results().getByRole('button', { name: 'Add Perfect by Ed Sheeran' })).toHaveTextContent('Added');
  expect(results().getByRole('button', { name: 'Add Perfect by Ed Sheeran' })).toBeDisabled();
  fireEvent.click(results().getByRole('button', { name: 'Add Perfect Symphony by Ed Sheeran & Andrea Bocelli' }));
  expect(picker('Must play').getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
  expect(picker('Must play').getByText('2 / 100')).toBeInTheDocument();
});

test('a song the catalogue does not have can be typed in to the chosen list', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  chooseList('Do not play');
  fireEvent.click(screen.getByRole('button', { name: "Can't find it? Type it in" }));
  fireEvent.change(screen.getByLabelText('Song title'), { target: { value: 'Our terrible song' } });
  fireEvent.change(screen.getByLabelText('Artist'), { target: { value: 'Uncle Pat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add typed-in song to Do not play' }));

  const dnp = picker('Do not play');
  expect(dnp.getByText('Our terrible song')).toBeInTheDocument();
  expect(dnp.getByText('Uncle Pat')).toBeInTheDocument();
  expect(screen.queryByLabelText('Song title')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].answers.doNotPlay).toEqual([
    { source: 'manual', id: null, title: 'Our terrible song', artist: 'Uncle Pat', album: null, artwork: null, previewUrl: null, url: null, durationMs: null }
  ]);
});

test('a playlist link imports its songs into the chosen list, skipping ones already there', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  search('bright');
  await waitResults();
  fireEvent.click(results().getByRole('button', { name: 'Add Mr Brightside by The Killers' }));

  fireEvent.click(screen.getByRole('button', { name: 'Import a playlist' }));
  fireEvent.change(screen.getByLabelText('Playlist link'), { target: { value: 'https://music.apple.com/gb/playlist/x/pl.u-abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import to Must play' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Added 1 song to Must play.');
  const must = picker('Must play');
  expect(must.getByRole('button', { name: 'Remove Dancing Queen' })).toBeInTheDocument();
  expect(must.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
  expect(must.getByText('2 / 100')).toBeInTheDocument();
});

test('a Spotify playlist link gets the explanation from the service', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  fireEvent.click(screen.getByRole('button', { name: 'Import a playlist' }));
  fireEvent.change(screen.getByLabelText('Playlist link'), { target: { value: 'https://open.spotify.com/playlist/abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import to Must play' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Spotify playlists cannot be imported.');
});

test('sending posts the picked songs and time fields, then allows editing again', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');

  fireEvent.change(screen.getByLabelText('DJ starts'), { target: { value: '19:30' } });
  chooseList('First dance');
  search('perfect');
  await waitResults();
  fireEvent.click(results().getByRole('button', { name: 'Add Perfect by Ed Sheeran' }));

  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByText(/Saved\. We've got your details/)).toBeInTheDocument();

  expect(posts).toHaveLength(1);
  expect(posts[0].answers.djStartTime).toBe('19:30');
  expect(posts[0].answers.firstDance).toEqual([CATALOGUE[0]]);
  expect(posts[0].answers.mustPlay).toEqual([]);

  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toBeDisabled();

  chooseList('Last song of the night');
  search('bright');
  await waitResults();
  fireEvent.click(results().getByRole('button', { name: 'Add Mr Brightside by The Killers' }));
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
  expect(first.queryByRole('button', { name: 'Add to First dance' })).not.toBeInTheDocument();
  // A typed-in list cannot be chosen as the search target, so its text is never silently replaced.
  const legacyOption = within(screen.getByLabelText('Adding to')).getByRole('option', { name: 'First dance (typed in)' });
  expect(legacyOption).toBeDisabled();
  fireEvent.click(first.getByRole('button', { name: 'Use song search instead' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(first.getByRole('button', { name: 'Add to First dance' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('a locked form is read-only with an explanation and no search', async () => {
  current = view({ locked: true, answers: { firstDance: 'Yellow – Coldplay', mustPlay: [song(200, 'Mr Brightside', 'The Killers')] }, submittedAt: 'x', updatedAt: 'x' });
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByRole('alert')).toHaveTextContent(/now locked/);
  expect(picker('First dance').getByLabelText('First dance')).toBeDisabled();
  expect(picker('Must play').queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Search for a song')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Save|Send/ })).not.toBeInTheDocument();
});

test('a server error on save is shown and the answers are kept', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  fireEvent.change(screen.getByLabelText('Anything else we should know?'), { target: { value: 'X' } });
  global.fetch.mockImplementationOnce(async () => jsonResponse(400, { error: 'djStartTime must be a time like 19:30' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('djStartTime must be a time like 19:30');
  expect(screen.getByLabelText('Anything else we should know?')).toHaveValue('X');
});

test('a 423 on save puts the page into the locked state instead of leaving it editable', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
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
  await screen.findByLabelText('Search for a song');
  search('slow');
  await waitFor(() => expect(searches).toContain('slow'));

  search('bright');
  await waitResults();
  resolveSlow();
  await new Promise((r) => setTimeout(r, 20));

  expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
  expect(results().getByRole('button', { name: 'Add Mr Brightside by The Killers' })).toBeInTheDocument();
});

test('starting a second preview while the first is still starting keeps the second marked as playing', async () => {
  let rejectFirst;
  window.HTMLMediaElement.prototype.play = jest
    .fn()
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
    .mockResolvedValue();

  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  search('perf');
  await waitResults();

  fireEvent.click(results().getByRole('button', { name: 'Preview Perfect' }));
  fireEvent.click(results().getByRole('button', { name: 'Preview Perfect Symphony' }));
  rejectFirst(new Error('interrupted'));
  await new Promise((r) => setTimeout(r, 0));

  expect(results().getByRole('button', { name: 'Stop preview of Perfect Symphony' })).toBeInTheDocument();
  expect(results().getByRole('button', { name: 'Preview Perfect' })).toBeInTheDocument();
});

test('a saved song still previews because playback goes through the preview route, not the stored link', async () => {
  current = view({
    answers: { mustPlay: [song(200, 'Mr Brightside', 'The Killers', { previewUrl: 'https://cdnt-preview.dzcdn.net/expired.mp3?hdnea=exp=1' })] },
    submittedAt: 'x',
    updatedAt: 'x'
  });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Must play' });
  const playSpy = window.HTMLMediaElement.prototype.play;
  fireEvent.click(picker('Must play').getByRole('button', { name: 'Preview Mr Brightside' }));
  expect(playSpy.mock.instances[0].src).toBe(`${API_BASE}/music/preview?source=apple&id=200`);
  expect(playSpy.mock.instances[0].src).not.toContain('expired');
});

test('a typed-in song has no preview button', async () => {
  current = view({ answers: { doNotPlay: [{ source: 'manual', id: null, title: 'Our terrible song', artist: '', album: null, artwork: null, previewUrl: null, url: null, durationMs: null }] }, submittedAt: 'x', updatedAt: 'x' });
  visit(`/plan/${TOKEN}`);
  await screen.findByRole('group', { name: 'Do not play' });
  expect(picker('Do not play').queryByRole('button', { name: /Preview/ })).not.toBeInTheDocument();
});

test('playlist import is offered only for the big lists', async () => {
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  expect(screen.getByRole('button', { name: 'Import a playlist' })).toBeInTheDocument();
  chooseList('Do not play');
  expect(screen.getByRole('button', { name: 'Import a playlist' })).toBeInTheDocument();
  chooseList('First dance');
  expect(screen.queryByRole('button', { name: 'Import a playlist' })).not.toBeInTheDocument();
  chooseList('Last song of the night');
  expect(screen.queryByRole('button', { name: 'Import a playlist' })).not.toBeInTheDocument();
});

test('the search target falls back when the chosen list is typed-in text', async () => {
  current = view({ answers: { mustPlay: 'Mr Brightside\nDancing Queen' }, submittedAt: 'x', updatedAt: 'x' });
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  // Must play is the usual default but is legacy text here, so the selector lands on the first usable list.
  await waitFor(() => expect(screen.getByLabelText('Adding to')).not.toHaveValue('mustPlay'));
  expect(screen.getByLabelText('Adding to')).toHaveValue('firstDance');
  expect(within(screen.getByLabelText('Adding to')).getByRole('option', { name: 'Must play (typed in)' })).toBeDisabled();
  expect(picker('Must play').getByLabelText('Must play')).toHaveValue('Mr Brightside\nDancing Queen');
});

test('a party asks only for set-up, arrival, start and finish times', async () => {
  current = view({ eventType: 'private', eventTypeLabel: 'event', weddingPackage: null });
  visit(`/plan/${TOKEN}`);
  await screen.findByLabelText('Search for a song');
  for (const label of ['When can we get in to set up?', 'Guests arrive', 'DJ starts', 'Music must finish by', 'Number of guests']) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
  expect(screen.queryByLabelText('Meal served')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Speeches')).not.toBeInTheDocument();
});

test('the guest count starts from the enquiry, is editable, and a saved value wins over the enquiry', async () => {
  const { unmount } = visit(`/plan/${TOKEN}`);
  const guests = await screen.findByLabelText('Number of guests');
  expect(guests).toHaveValue(150);
  expect(screen.getByRole('button', { name: 'Send us your details' })).toBeDisabled();

  fireEvent.change(guests, { target: { value: '120' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send us your details' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].answers.guestCount).toBe('120');

  unmount();
  current = view({ answers: { guestCount: 95 }, submittedAt: 'x', updatedAt: 'x' });
  visit(`/plan/${TOKEN}`);
  expect(await screen.findByLabelText('Number of guests')).toHaveValue(95);
});
