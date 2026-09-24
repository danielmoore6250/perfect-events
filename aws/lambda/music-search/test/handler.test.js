// Tests for song search. Apple and Deezer are stubbed at global fetch; Parameter
// Store at the SSM client. A real EC key is generated to prove the developer
// token verifies as ES256.

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { SSMClient } = require('@aws-sdk/client-ssm');

const HANDLER_PATH = path.join(__dirname, '..', 'index.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const loadModule = () => {
  delete require.cache[HANDLER_PATH];
  const mod = require(HANDLER_PATH);
  mod._resetForTests();
  return mod;
};

const request = (rawPath, query = {}, method = 'GET') => ({
  requestContext: { http: { method } },
  rawPath,
  queryStringParameters: query
});

const appleSong = (id, name, artist) => ({
  id,
  type: 'songs',
  attributes: {
    name,
    artistName: artist,
    albumName: `${name} (Single)`,
    artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg' },
    previews: [{ url: `https://audio-ssl.itunes.apple.com/${id}.m4a` }],
    durationInMillis: 263000,
    url: `https://music.apple.com/gb/album/x/${id}`
  }
});

const deezerTrack = (id, title, artist) => ({
  id,
  title,
  duration: 263,
  preview: `https://cdnt-preview.dzcdn.net/${id}.mp3`,
  link: `https://www.deezer.com/track/${id}`,
  artist: { name: artist },
  album: { title: '÷ (Deluxe)', cover_medium: `https://cdn-images.dzcdn.net/${id}/250x250.jpg` }
});

let appleConfigured;
let fetches;
let appleFails;

beforeEach(() => {
  appleConfigured = true;
  appleFails = false;
  fetches = [];

  mock.method(SSMClient.prototype, 'send', async () => ({
    Parameters: appleConfigured
      ? [
          { Name: '/perfect-events/apple-music/private-key', Value: PEM },
          { Name: '/perfect-events/apple-music/key-id', Value: 'KEY1234567' },
          { Name: '/perfect-events/apple-music/team-id', Value: 'TEAM123456' }
        ]
      : []
  }));

  global.fetch = async (url, init = {}) => {
    fetches.push({ url, headers: init.headers || {} });
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

    if (u.hostname === 'api.music.apple.com') {
      if (appleFails) return json({ errors: [{ status: '401' }] }, 401);
      if (u.pathname.endsWith('/search')) {
        const term = u.searchParams.get('term');
        return json({ results: { songs: { data: [appleSong('100', `${term} (Apple)`, 'Ed Sheeran'), appleSong('101', 'Perfect Symphony', 'Ed Sheeran & Andrea Bocelli')] } } });
      }
      if (u.pathname.includes('/playlists/pl.u-abc/tracks')) {
        if (u.searchParams.get('offset') === '100') return json({ data: [appleSong('202', 'Second page', 'B')] });
        return json({ data: [appleSong('201', 'First page', 'A'), { id: 'mv1', type: 'music-videos', attributes: { name: 'skip me' } }], next: '/v1/catalog/gb/playlists/pl.u-abc/tracks?offset=100' });
      }
      return json({ errors: [] }, 404);
    }

    if (u.hostname === 'api.deezer.com') {
      if (u.pathname === '/search') {
        return json({ data: [deezerTrack(1, `${u.searchParams.get('q')} (Deezer)`, 'Ed Sheeran')], total: 1 });
      }
      if (u.pathname === '/playlist/3155776842/tracks') {
        return json({ data: [deezerTrack(7, 'Boston', 'Augustana')] });
      }
      if (u.pathname === '/playlist/404/tracks') {
        return json({ error: { message: 'no data' } });
      }
    }
    return json({}, 500);
  };

  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

afterEach(() => mock.restoreAll());

test('the developer token is a valid ES256 JWT with the right claims', () => {
  const { signDeveloperToken } = loadModule();
  const token = signDeveloperToken({ privateKey: PEM, keyId: 'KEY1234567', teamId: 'TEAM123456' }, 1_700_000_000_000);
  const [h, p, sig] = token.split('.');

  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.iat, 1_700_000_000);
  assert.equal(claims.exp, 1_700_000_000 + 86400);

  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert.equal(ok, true);
});

test('search uses Apple Music when the key is configured and normalises the songs', async () => {
  const { handler } = loadModule();
  const res = await handler(request('/music/search', { q: '  perfect   ed sheeran ' }));

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'apple');
  assert.equal(body.songs.length, 2);
  assert.deepEqual(body.songs[0], {
    source: 'apple',
    id: '100',
    title: 'perfect ed sheeran (Apple)',
    artist: 'Ed Sheeran',
    album: 'perfect ed sheeran (Apple) (Single)',
    artwork: 'https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg',
    previewUrl: 'https://audio-ssl.itunes.apple.com/100.m4a',
    durationMs: 263000,
    url: 'https://music.apple.com/gb/album/x/100'
  });

  const apple = fetches.find((f) => f.url.includes('api.music.apple.com'));
  assert.match(apple.headers.Authorization, /^Bearer ey/);
  assert.ok(apple.url.includes('/catalog/gb/search?term=perfect%20ed%20sheeran&types=songs&limit=10'));
});

test('search falls back to Deezer when no Apple key is configured', async () => {
  appleConfigured = false;
  const { handler } = loadModule();
  const res = await handler(request('/music/search', { q: 'perfect' }));

  const body = JSON.parse(res.body);
  assert.equal(body.source, 'deezer');
  assert.deepEqual(body.songs[0], {
    source: 'deezer',
    id: '1',
    title: 'perfect (Deezer)',
    artist: 'Ed Sheeran',
    album: '÷ (Deluxe)',
    artwork: 'https://cdn-images.dzcdn.net/1/250x250.jpg',
    previewUrl: 'https://cdnt-preview.dzcdn.net/1.mp3',
    durationMs: 263000,
    url: 'https://www.deezer.com/track/1'
  });
  assert.ok(!fetches.some((f) => f.url.includes('api.music.apple.com')));
});

test('search falls back to Deezer when Apple rejects the token', async () => {
  appleFails = true;
  const { handler } = loadModule();
  const res = await handler(request('/music/search', { q: 'perfect' }));
  assert.equal(JSON.parse(res.body).source, 'deezer');
});

test('search results are cached per query and limit', async () => {
  const { handler } = loadModule();
  await handler(request('/music/search', { q: 'Perfect' }));
  await handler(request('/music/search', { q: 'perfect' }));
  await handler(request('/music/search', { q: 'perfect', limit: '5' }));
  const appleCalls = fetches.filter((f) => f.url.includes('/search?'));
  assert.equal(appleCalls.length, 2, 'same query differing only by case is served from cache');
});

test('limit is clamped and q is validated', async () => {
  const { handler } = loadModule();
  await handler(request('/music/search', { q: 'x', limit: '999' }));
  assert.ok(fetches.at(-1).url.includes('limit=25'));
  await handler(request('/music/search', { q: 'y', limit: '-3' }));
  assert.ok(fetches.at(-1).url.includes('limit=10'));

  assert.equal((await handler(request('/music/search', {}))).statusCode, 400);
  assert.equal((await handler(request('/music/search', { q: '   ' }))).statusCode, 400);
  assert.equal((await handler(request('/music/search', { q: 'x'.repeat(101) }))).statusCode, 400);
});

test('an Apple Music playlist link imports every song across pages, skipping non-songs', async () => {
  const { handler } = loadModule();
  const res = await handler(request('/music/playlist', { url: 'https://music.apple.com/gb/playlist/wedding-bangers/pl.u-abc' }));

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'apple');
  assert.deepEqual(body.songs.map((s) => s.title), ['First page', 'Second page']);
});

test('a Deezer playlist link imports its tracks', async () => {
  const { handler } = loadModule();
  const res = await handler(request('/music/playlist', { url: 'https://www.deezer.com/en/playlist/3155776842' }));
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'deezer');
  assert.equal(body.songs[0].title, 'Boston');
});

test('playlist import explains unsupported and malformed links', async () => {
  const { handler } = loadModule();
  const cases = [
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 400, /Spotify playlists cannot be imported/],
    ['https://music.apple.com/gb/album/divide/1193701079', 400, /not a playlist/],
    ['https://www.deezer.com/en/track/142986206', 400, /not a playlist/],
    ['https://example.com/playlist/1', 400, /Only Apple Music and Deezer/],
    ['not a link', 400, /does not look like a link/],
    ['', 400, /url is required/]
  ];
  for (const [url, status, pattern] of cases) {
    const res = await handler(request('/music/playlist', { url }));
    assert.equal(res.statusCode, status, url);
    assert.match(JSON.parse(res.body).error, pattern);
  }
});

test('an Apple playlist without an Apple key is a clear 503', async () => {
  appleConfigured = false;
  const { handler } = loadModule();
  const res = await handler(request('/music/playlist', { url: 'https://music.apple.com/gb/playlist/x/pl.u-abc' }));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /not available right now/);
});

test('a Deezer error on playlist import is a friendly 502', async () => {
  const { handler } = loadModule();
  const res = await handler(request('/music/playlist', { url: 'https://www.deezer.com/playlist/404' }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /type a song in by name/);
});

test('unknown paths and methods are 404, OPTIONS is 204', async () => {
  const { handler } = loadModule();
  assert.equal((await handler(request('/music/other', { q: 'x' }))).statusCode, 404);
  assert.equal((await handler(request('/music/search', { q: 'x' }, 'POST'))).statusCode, 404);
  assert.equal((await handler(request('/music/search', {}, 'OPTIONS'))).statusCode, 204);
});

test('the Apple key is read from Parameter Store once per container', async () => {
  const { handler } = loadModule();
  await handler(request('/music/search', { q: 'a' }));
  await handler(request('/music/search', { q: 'b' }));
  assert.equal(SSMClient.prototype.send.mock.callCount(), 1);
});
