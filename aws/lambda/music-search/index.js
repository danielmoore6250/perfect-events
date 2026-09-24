// Song search for the client planning form.
//
//   GET /music/search?q=perfect            up to 25 matching songs
//   GET /music/playlist?url=<link>         every track in a public playlist
//
// Apple Music is the catalogue when a MusicKit key is in Parameter Store; the
// Lambda signs the developer token itself. Deezer needs no key and is the
// fallback, so search keeps working even if the Apple key is missing or
// expired. Both are normalised to one song shape so the page and the stored
// data never care which catalogue answered.

const crypto = require('crypto');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');

const REGION = process.env.AWS_REGION || 'eu-west-1';
const ssm = new SSMClient({ region: REGION });

const APPLE_PARAM_PREFIX = process.env.APPLE_MUSIC_PARAM_PREFIX || '/perfect-events/apple-music';
const APPLE_STOREFRONT = 'gb';
const APPLE_API = 'https://api.music.apple.com/v1';
const DEEZER_API = 'https://api.deezer.com';

// Per-caller limit, kept in memory per container. Best effort (each container
// counts separately) but it stops one address hammering the catalogues.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_SEARCHES = 60;
const RATE_MAX_IMPORTS = 10;

const MAX_QUERY_LENGTH = 100;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_PLAYLIST_TRACKS = 300;
const FETCH_TIMEOUT_MS = 6000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300'
};

const respond = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

// ---- Apple Music --------------------------------------------------------------

// The MusicKit key: a P8 private key plus its key id and the team id. Cached
// for the life of the container; absence just means Apple is off.
let appleCredentials; // undefined = not loaded yet, null = not configured
const loadAppleCredentials = async () => {
  if (appleCredentials !== undefined) return appleCredentials;
  try {
    const names = ['private-key', 'key-id', 'team-id'].map((n) => `${APPLE_PARAM_PREFIX}/${n}`);
    const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    const byName = Object.fromEntries(Parameters.map((p) => [p.Name.split('/').pop(), p.Value]));
    if (byName['private-key'] && byName['key-id'] && byName['team-id']) {
      appleCredentials = { privateKey: byName['private-key'], keyId: byName['key-id'], teamId: byName['team-id'] };
    } else {
      console.warn('Apple Music key not configured; using Deezer only');
      appleCredentials = null;
    }
  } catch (err) {
    console.error('Could not load Apple Music credentials:', err.message);
    appleCredentials = null;
  }
  return appleCredentials;
};

const base64url = (input) => Buffer.from(input).toString('base64url');

// An ES256 JWT, which is all a MusicKit developer token is. Node signs
// directly to the raw r||s form the JWT spec wants with dsaEncoding.
const signDeveloperToken = ({ privateKey, keyId, teamId }, now = Date.now()) => {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const iat = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({ iss: teamId, iat, exp: iat + 24 * 60 * 60 }));
  const signature = crypto
    .sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
};

let cachedToken = null;
const appleToken = async () => {
  const creds = await loadAppleCredentials();
  if (!creds) return null;
  if (!cachedToken || cachedToken.expiresAt < Date.now()) {
    cachedToken = { value: signDeveloperToken(creds), expiresAt: Date.now() + TOKEN_TTL_MS };
  }
  return cachedToken.value;
};

const appleArtwork = (artwork, size = 300) =>
  artwork?.url ? artwork.url.replace('{w}', String(size)).replace('{h}', String(size)) : null;

const fromApple = (song) => {
  const a = song.attributes || {};
  return {
    source: 'apple',
    id: String(song.id),
    title: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || null,
    artwork: appleArtwork(a.artwork),
    previewUrl: a.previews?.[0]?.url || null,
    durationMs: typeof a.durationInMillis === 'number' ? a.durationInMillis : null,
    url: a.url || null
  };
};

const appleSearch = async (token, query, limit) => {
  const url = `${APPLE_API}/catalog/${APPLE_STOREFRONT}/search?term=${encodeURIComponent(query)}&types=songs&limit=${limit}`;
  const data = await fetchJson(url, { Authorization: `Bearer ${token}` });
  return (data.results?.songs?.data || []).map(fromApple);
};

// music.apple.com/gb/playlist/<slug>/pl.u-xxxx  (the id is the last segment)
const applePlaylistId = (link) => {
  const match = link.pathname.match(/\/playlist\/(?:[^/]+\/)?(pl\.[A-Za-z0-9._-]+)\/?$/);
  return match ? match[1] : null;
};

const applePlaylist = async (token, id) => {
  const tracks = [];
  let next = `/catalog/${APPLE_STOREFRONT}/playlists/${id}/tracks?limit=100`;
  while (next && tracks.length < MAX_PLAYLIST_TRACKS) {
    const data = await fetchJson(`${APPLE_API}${next.replace(/^\/v1/, '')}`, { Authorization: `Bearer ${token}` });
    tracks.push(...(data.data || []).filter((t) => t.type === 'songs').map(fromApple));
    next = data.next || null;
  }
  return tracks.slice(0, MAX_PLAYLIST_TRACKS);
};

// ---- Deezer -------------------------------------------------------------------

const fromDeezer = (track) => ({
  source: 'deezer',
  id: String(track.id),
  title: track.title || '',
  artist: track.artist?.name || '',
  album: track.album?.title || null,
  artwork: track.album?.cover_medium || track.album?.cover || null,
  previewUrl: track.preview || null,
  durationMs: typeof track.duration === 'number' ? track.duration * 1000 : null,
  url: track.link || null
});

const deezerSearch = async (query, limit) => {
  const data = await fetchJson(`${DEEZER_API}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (data.error) throw new Error(`Deezer: ${data.error.message || 'error'}`);
  return (data.data || []).map(fromDeezer);
};

// deezer.com/<lang>/playlist/<id>
const deezerPlaylistId = (link) => {
  const match = link.pathname.match(/\/playlist\/(\d+)\/?$/);
  return match ? match[1] : null;
};

const deezerPlaylist = async (id) => {
  const tracks = [];
  let next = `${DEEZER_API}/playlist/${id}/tracks?limit=100`;
  while (next && tracks.length < MAX_PLAYLIST_TRACKS) {
    const data = await fetchJson(next);
    if (data.error) throw new Error(`Deezer: ${data.error.message || 'error'}`);
    tracks.push(...(data.data || []).map(fromDeezer));
    next = data.next || null;
  }
  return tracks.slice(0, MAX_PLAYLIST_TRACKS);
};

// ---- Search with cache and fallback ---------------------------------------------

const searchCache = new Map();
const cacheGet = (key) => {
  const hit = searchCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  searchCache.delete(key);
  return null;
};
const cacheSet = (key, value) => {
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
};

const search = async (query, limit) => {
  const key = `${query.toLowerCase()}|${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let result;
  const token = await appleToken();
  if (token) {
    try {
      result = { source: 'apple', songs: await appleSearch(token, query, limit) };
    } catch (err) {
      console.error('Apple Music search failed, falling back to Deezer:', err.message);
    }
  }
  if (!result) result = { source: 'deezer', songs: await deezerSearch(query, limit) };

  cacheSet(key, result);
  return result;
};

const importPlaylist = async (rawUrl) => {
  let link;
  try {
    link = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'That does not look like a link');
  }

  if (/(^|\.)music\.apple\.com$/.test(link.hostname)) {
    const id = applePlaylistId(link);
    if (!id) throw new HttpError(400, 'That Apple Music link is not a playlist');
    const token = await appleToken();
    if (!token) throw new HttpError(503, 'Apple Music playlists are not available right now. Try a Deezer playlist link, or add songs one at a time.');
    return { source: 'apple', songs: await applePlaylist(token, id) };
  }

  if (/(^|\.)deezer\.com$/.test(link.hostname)) {
    const id = deezerPlaylistId(link);
    if (!id) throw new HttpError(400, 'That Deezer link is not a playlist');
    return { source: 'deezer', songs: await deezerPlaylist(id) };
  }

  if (/spotify\.com$/.test(link.hostname)) {
    throw new HttpError(400, 'Spotify playlists cannot be imported. Share it as an Apple Music or Deezer playlist, or add the songs by searching.');
  }
  throw new HttpError(400, 'Only Apple Music and Deezer playlist links are supported');
};

// ---- Per-address rate limit -----------------------------------------------

const buckets = new Map(); // ip -> { windowStart, searches, imports }
const rateCheck = (ip, kind, now = Date.now()) => {
  if (buckets.size > 5000) buckets.clear();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { windowStart: now, searches: 0, imports: 0 };
    buckets.set(ip, b);
  }
  if (kind === 'search') {
    b.searches += 1;
    return b.searches <= RATE_MAX_SEARCHES;
  }
  b.imports += 1;
  return b.imports <= RATE_MAX_IMPORTS;
};

// ---- Handler --------------------------------------------------------------

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (method !== 'GET') return respond(404, { error: 'Not found' });

  const path = (event.rawPath || event.path || '').replace(/\/+$/, '');
  const params = event.queryStringParameters || {};
  const ip = event.requestContext?.http?.sourceIp || 'unknown';

  try {
    if (path === '/music/search' || path === '/music/playlist') {
      if (!rateCheck(ip, path === '/music/search' ? 'search' : 'import')) {
        throw new HttpError(429, 'Slow down a little and try again in a minute.');
      }
    }

    if (path === '/music/search') {
      const query = String(params.q || '').trim().replace(/\s+/g, ' ');
      if (!query) throw new HttpError(400, 'q is required');
      if (query.length > MAX_QUERY_LENGTH) throw new HttpError(400, `q must be at most ${MAX_QUERY_LENGTH} characters`);
      const requested = parseInt(params.limit, 10);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
      return respond(200, await search(query, limit));
    }

    if (path === '/music/playlist') {
      const url = String(params.url || '').trim();
      if (!url) throw new HttpError(400, 'url is required');
      return respond(200, await importPlaylist(url));
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) return respond(err.statusCode, { error: err.message });
    console.error('Music request failed:', err);
    return respond(502, { error: 'Song search is not available right now. You can still type a song in by name.' });
  }
};

exports.signDeveloperToken = signDeveloperToken;
exports.rateCheck = rateCheck;
exports._resetForTests = () => {
  appleCredentials = undefined;
  cachedToken = null;
  searchCache.clear();
  buckets.clear();
};
