// Client planning form: GET and POST /plan/{token}
//
// A booked client gets a private link. GET returns just enough of the booking
// to greet them and prefill the form; POST saves their answers. The first
// submission moves the booking to 'details-received' and emails the business.
// Editing locks a few days before the event so the running order is stable.
// A wrong token is a 404 identical to a missing route.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const REGION = process.env.AWS_REGION || 'eu-west-1';
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});
const sesClient = new SESv2Client({ region: REGION });

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const BY_PLANNING_TOKEN_INDEX = 'ByPlanningToken';
const BUSINESS_EMAIL = 'enquiries@perfecteventsni.com';
const FROM = 'Perfect Events NI <enquiries@perfecteventsni.com>';
const ADMIN_URL = 'https://perfecteventsni.com/admin';

// Editing closes once the event is this many days away or closer.
const LOCK_DAYS_BEFORE = 3;

// Every field the form can save. Anything else in the body is rejected.
//   time:   HH:MM, 24-hour
//   number: a whole number (guest count)
//   short:  single line
//   long:   free text
//   dances: named dances, each { name, song | null }
//   links:  shared playlist links (Spotify, Apple Music, Deezer, YouTube)
//   songs:  a list of song records picked from the catalogue (or typed in), up
//          to `max` of them. A plain string is still accepted for these, which
//          is how forms filled in before the song picker existed were saved.
const FIELDS = {
  guestCount: { type: 'number', min: 1, max: 5000 },
  setupAccessTime: { type: 'time' },
  guestArrivalTime: { type: 'time' },
  mealTime: { type: 'time' },
  speechesTime: { type: 'time' },
  djStartTime: { type: 'time' },
  finishTime: { type: 'time' },
  firstDance: { type: 'songs', max: 1, textMax: 200 },
  parentDances: { type: 'songs', max: 5, textMax: 200 }, // before dances had names; still accepted
  namedDances: { type: 'dances', max: 8 },
  lastSong: { type: 'songs', max: 1, textMax: 200 },
  mustPlay: { type: 'songs', max: 100, textMax: 3000 },
  doNotPlay: { type: 'songs', max: 100, textMax: 3000 },
  playlistLinks: { type: 'links', max: 10 },
  musicStyle: { type: 'long' },
  announcements: { type: 'long' },
  venueContactName: { type: 'short' },
  venueContactPhone: { type: 'short' },
  accessNotes: { type: 'long' },
  extraNotes: { type: 'long' }
};
const MAX_LENGTH = { time: 5, short: 200, long: 3000 };

// One picked song. Only these keys are stored; anything else is dropped.
const SONG_SOURCES = new Set(['apple', 'deezer', 'manual']);
const SONG_TEXT_MAX = 200;
const SONG_URL_MAX = 600;

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const parseSong = (raw, field) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `${field} entries must be songs`);
  const text = (key, max = SONG_TEXT_MAX) => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new HttpError(400, `${field}: ${key} must be text`);
    const t = v.trim();
    if (t.length > max) throw new HttpError(400, `${field}: ${key} is too long`);
    return t || null;
  };
  const url = (key) => {
    const v = text(key, SONG_URL_MAX);
    if (v && !isHttpsUrl(v)) throw new HttpError(400, `${field}: ${key} must be an https link`);
    return v;
  };

  const source = text('source');
  if (!SONG_SOURCES.has(source)) throw new HttpError(400, `${field}: source must be apple, deezer or manual`);
  const title = text('title');
  if (!title) throw new HttpError(400, `${field}: every song needs a title`);

  const song = {
    source,
    id: source === 'manual' ? null : text('id', 100),
    title,
    artist: text('artist') || '',
    album: text('album'),
    artwork: url('artwork'),
    previewUrl: url('previewUrl'),
    url: url('url'),
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : null
  };
  if (song.source !== 'manual' && !song.id) throw new HttpError(400, `${field}: catalogue songs need an id`);
  return song;
};

const parseSongs = (raw, key, spec) => {
  // Legacy: plain text from before the picker.
  if (typeof raw === 'string') {
    const value = raw.replace(/\r\n/g, '\n').trim();
    if (!value) return undefined;
    if (value.length > spec.textMax) throw new HttpError(400, `${key} is too long (max ${spec.textMax} characters)`);
    return value;
  }
  if (!Array.isArray(raw)) throw new HttpError(400, `${key} must be a list of songs`);
  if (raw.length > spec.max) throw new HttpError(400, `${key} can hold at most ${spec.max} song${spec.max === 1 ? '' : 's'}`);
  const songs = raw.map((entry) => parseSong(entry, key));
  return songs.length ? songs : undefined;
};

// One shared playlist link. The provider is derived from the link itself and
// the path must be a playlist, so the saved metadata can never mislead.
const LINK_RULES = [
  { provider: 'spotify', host: /(^|\.)spotify\.com$/, path: (u) => /^\/(?:intl-[a-z]+\/)?playlist\/[A-Za-z0-9]+\/?$/.test(u.pathname) },
  { provider: 'apple', host: /(^|\.)music\.apple\.com$/, path: (u) => /\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9._-]+\/?$/.test(u.pathname) },
  { provider: 'deezer', host: /(^|\.)deezer\.com$/, path: (u) => /\/playlist\/\d+\/?$/.test(u.pathname) },
  { provider: 'youtube', host: /(^|\.)(youtube\.com|music\.youtube\.com)$/, path: (u) => /^\/playlist\/?$/.test(u.pathname) && /^[A-Za-z0-9_-]+$/.test(u.searchParams.get('list') || '') }
];

const parseLink = (raw, field) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `${field} entries must be links`);
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `${field}: not a valid link`);
  }
  const rule = parsed.protocol === 'https:' && url.length <= SONG_URL_MAX ? LINK_RULES.find((r) => r.host.test(parsed.hostname)) : null;
  if (!rule) throw new HttpError(400, `${field}: links must be Spotify, Apple Music, Deezer or YouTube`);
  if (!rule.path(parsed)) throw new HttpError(400, `${field}: that link is not a playlist`);
  const text = (key) => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new HttpError(400, `${field}: ${key} must be text`);
    const t = v.trim();
    if (t.length > SONG_URL_MAX) throw new HttpError(400, `${field}: ${key} is too long`);
    return t || null;
  };
  const thumbnail = text('thumbnail');
  if (thumbnail && !isHttpsUrl(thumbnail)) throw new HttpError(400, `${field}: thumbnail must be an https link`);
  return { url, provider: rule.provider, title: text('title')?.slice(0, 200) || null, thumbnail };
};

const parseLinks = (raw, key, spec) => {
  if (!Array.isArray(raw)) throw new HttpError(400, `${key} must be a list of links`);
  if (raw.length > spec.max) throw new HttpError(400, `${key} can hold at most ${spec.max} links`);
  const links = raw.map((entry) => parseLink(entry, key));
  return links.length ? links : undefined;
};

const DANCE_NAME_MAX = 80;
const parseDances = (raw, key, spec) => {
  if (!Array.isArray(raw)) throw new HttpError(400, `${key} must be a list of dances`);
  if (raw.length > spec.max) throw new HttpError(400, `${key} can hold at most ${spec.max} dances`);
  const dances = raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpError(400, `${key} entries must be dances`);
    if (entry.name !== undefined && entry.name !== null && typeof entry.name !== 'string') throw new HttpError(400, `${key}: name must be text`);
    const name = (entry.name || '').trim();
    if (name.length > DANCE_NAME_MAX) throw new HttpError(400, `${key}: a dance name is too long`);
    const song = entry.song === undefined || entry.song === null ? null : parseSong(entry.song, key);
    return { name, song };
  }).filter((d) => d.name || d.song);
  return dances.length ? dances : undefined;
};

const dancesToText = (value) =>
  Array.isArray(value)
    ? value.map((d) => `${d.name || 'Dance'}: ${d.song ? (d.song.artist ? `${d.song.artist} – ${d.song.title}` : d.song.title) : 'song to be confirmed'}`).join('\n')
    : '';

const PROVIDER_LABELS = { spotify: 'Spotify', apple: 'Apple Music', deezer: 'Deezer', youtube: 'YouTube' };
const linksToText = (value) =>
  Array.isArray(value) ? value.map((l) => `${l.title || 'Playlist'} (${PROVIDER_LABELS[l.provider] || l.provider}) ${l.url}`).join('\n') : '';

// A song list as plain text: "Artist – Title" per line. Legacy text passes through.
const songsToText = (value) => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((s) => (s.artist ? `${s.artist} – ${s.title}` : s.title)).join('\n');
};

const EVENT_TYPE_LABELS = {
  wedding: 'wedding',
  private: 'event',
  corporate: 'corporate event',
  'pa-hire': 'event'
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const respond = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ---- Validation -----------------------------------------------------------

const isTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const parseAnswers = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  const answers = body.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new HttpError(400, 'answers must be an object');
  }

  const clean = {};
  for (const key of Object.keys(answers)) {
    // Own-property check: names like "constructor" or "__proto__" would
    // otherwise resolve to something truthy on a plain object.
    if (!Object.hasOwn(FIELDS, key)) throw new HttpError(400, `Unknown field: ${key}`);
    const spec = FIELDS[key];

    const raw = answers[key];
    if (raw === null || raw === undefined) continue;

    if (spec.type === 'songs') {
      const songs = parseSongs(raw, key, spec);
      if (songs !== undefined) clean[key] = songs;
      continue;
    }

    if (spec.type === 'dances') {
      const dances = parseDances(raw, key, spec);
      if (dances !== undefined) clean[key] = dances;
      continue;
    }

    if (spec.type === 'links') {
      const links = parseLinks(raw, key, spec);
      if (links !== undefined) clean[key] = links;
      continue;
    }

    if (spec.type === 'number') {
      const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
      if (text === null) throw new HttpError(400, `${key} must be a number`);
      if (text === '') continue;
      const n = Number(text);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new HttpError(400, `${key} must be a whole number between ${spec.min} and ${spec.max}`);
      }
      clean[key] = n;
      continue;
    }

    if (typeof raw !== 'string') throw new HttpError(400, `${key} must be text`);

    const value = raw.replace(/\r\n/g, '\n').trim();
    if (!value) continue;
    if (value.length > MAX_LENGTH[spec.type]) {
      throw new HttpError(400, `${key} is too long (max ${MAX_LENGTH[spec.type]} characters)`);
    }
    if (spec.type === 'time' && !isTime(value)) {
      throw new HttpError(400, `${key} must be a time like 19:30`);
    }
    clean[key] = value;
  }
  return clean;
};

// ---- Dates ----------------------------------------------------------------

const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// Today's calendar date where the business is, not UTC: during British Summer
// Time the two differ for an hour every night.
const BUSINESS_TIMEZONE = 'Europe/London';
const todayInBusinessTimezone = (now) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
};

// Locked when the event is LOCK_DAYS_BEFORE days away or closer, and after it.
const isLocked = (eventDate, now = new Date()) => {
  if (!isIsoDate(eventDate)) return false;
  const [y, m, d] = eventDate.split('-').map(Number);
  const event = Date.UTC(y, m - 1, d);
  const daysUntil = Math.round((event - todayInBusinessTimezone(now)) / 86400000);
  return daysUntil <= LOCK_DAYS_BEFORE;
};

// Built by hand rather than via toLocaleDateString so the wording does not
// change with the ICU data in whichever Node runtime happens to run it.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const formatEventDate = (iso) => {
  if (!isIsoDate(iso)) return 'a date still to be confirmed';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
};

// ---- Data access ----------------------------------------------------------

const findByToken = async (token) => {
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: BOOKINGS_TABLE,
      IndexName: BY_PLANNING_TOKEN_INDEX,
      KeyConditionExpression: 'planningToken = :token',
      ExpressionAttributeValues: { ':token': token },
      Limit: 1
    })
  );
  const booking = Items && Items[0];
  if (!booking || booking.recordType !== 'booking') throw new HttpError(404, 'Not found');
  return booking;
};

// What the client is allowed to see: enough to know they have the right link
// and to prefill their own answers. No phone, email, pricing, notes or history.
const clientView = (b) => ({
  clientName: b.client?.name || '',
  eventDate: isIsoDate(b.eventDate) ? b.eventDate : null,
  eventDateLabel: formatEventDate(b.eventDate),
  eventType: b.event?.type || null,
  eventTypeLabel: EVENT_TYPE_LABELS[b.event?.type] || 'event',
  weddingPackage: b.event?.type === 'wedding' ? b.event?.weddingPackage || null : null,
  venue: b.event?.venue || null,
  guestCount: b.event?.guestCount || null,
  locked: isLocked(b.eventDate),
  answers: b.planning?.answers || {},
  submittedAt: b.planning?.submittedAt || null,
  updatedAt: b.planning?.updatedAt || null
});

const saveAnswers = async (booking, answers) => {
  const now = new Date().toISOString();
  const firstSubmission = !booking.planning?.submittedAt;
  const advanceStatus = firstSubmission && ['booked', 'details-requested'].includes(booking.status);

  const names = { '#planning': 'planning', '#updatedAt': 'updatedAt', '#planningToken': 'planningToken' };
  const values = {
    ':planning': {
      answers,
      submittedAt: booking.planning?.submittedAt || now,
      updatedAt: now
    },
    ':now': now,
    ':token': booking.planningToken
  };
  const sets = ['#planning = :planning', '#updatedAt = :now'];

  if (advanceStatus) {
    names['#status'] = 'status';
    names['#statusHistory'] = 'statusHistory';
    values[':status'] = 'details-received';
    values[':entry'] = [{ status: 'details-received', at: now, by: 'client-planning-form' }];
    values[':empty'] = [];
    sets.push('#status = :status');
    sets.push('#statusHistory = list_append(if_not_exists(#statusHistory, :empty), :entry)');
  }

  // If the link was regenerated between the client loading and saving, the
  // save must not land on a token they no longer hold. On a first submission
  // the record must still have no planning, so two simultaneous first saves
  // cannot both advance the stage and email twice; the loser retries as an edit.
  const conditions = ['attribute_exists(id)', '#planningToken = :token'];
  if (firstSubmission) conditions.push('attribute_not_exists(#planning)');

  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: BOOKINGS_TABLE,
      Key: { id: booking.id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    })
  );
  return { booking: Attributes, firstSubmission };
};

// ---- Notification ---------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const FIELD_LABELS = {
  guestCount: 'Guests',
  setupAccessTime: 'Set-up access from',
  guestArrivalTime: 'Guests arrive',
  mealTime: 'Meal served',
  speechesTime: 'Speeches',
  djStartTime: 'DJ starts',
  finishTime: 'Music finishes',
  firstDance: 'First dance',
  parentDances: 'Parent dances',
  namedDances: 'Other dances',
  lastSong: 'Last song',
  mustPlay: 'Must play',
  doNotPlay: 'Do not play',
  playlistLinks: 'Playlists',
  musicStyle: 'Music style',
  announcements: 'Announcements',
  venueContactName: 'Venue contact',
  venueContactPhone: 'Venue phone',
  accessNotes: 'Access notes',
  extraNotes: 'Anything else we need to know'
};

const notifyBusiness = async (booking, firstSubmission) => {
  const name = booking.client?.name || 'Unknown client';
  const when = formatEventDate(booking.eventDate);
  const subject = `${firstSubmission ? 'Planning details received' : 'Planning details updated'}: ${name}, ${when}`;
  const link = `${ADMIN_URL}/${booking.id}`;
  const answers = booking.planning?.answers || {};

  const asText = (key) => {
    const type = FIELDS[key].type;
    if (type === 'songs') return songsToText(answers[key]);
    if (type === 'links') return linksToText(answers[key]);
    if (type === 'dances') return dancesToText(answers[key]);
    return String(answers[key] ?? '');
  };
  const answered = Object.keys(FIELDS).filter((key) => answers[key] !== undefined && answers[key] !== null && answers[key] !== '' && asText(key));
  const rows = answered
    .map((key) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(FIELD_LABELS[key])}</td><td style="padding:6px 0">${esc(asText(key)).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  const text = answered.map((key) => `${FIELD_LABELS[key]}: ${asText(key)}`).join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;max-width:640px">
<h2 style="margin:0 0 4px">${esc(name)} has ${firstSubmission ? 'filled in' : 'updated'} their planning form</h2>
<p style="margin:0 0 16px;color:#666">${esc(when)}${booking.event?.venue ? ` · ${esc(booking.event.venue)}` : ''}</p>
<table style="border-collapse:collapse">${rows}</table>
<p style="margin-top:20px"><a href="${link}">Open this booking in the admin screen</a></p>
</body></html>`;

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [BUSINESS_EMAIL] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: {
            Html: { Data: html },
            Text: { Data: `${name} has ${firstSubmission ? 'filled in' : 'updated'} their planning form.\n${when}\n\n${text}\n\n${link}` }
          }
        }
      }
    })
  );
};

// ---- Handler --------------------------------------------------------------

const parseBody = (event) => {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
};

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const token = String(event.pathParameters?.token || '').trim();

  try {
    if (!token || !/^[A-Za-z0-9_-]{16,}$/.test(token) || !BOOKINGS_TABLE) throw new HttpError(404, 'Not found');

    if (method === 'GET') {
      return respond(200, { booking: clientView(await findByToken(token)) });
    }

    if (method === 'POST') {
      const booking = await findByToken(token);
      if (isLocked(booking.eventDate)) {
        throw new HttpError(423, 'This form is now locked because the event is only a few days away. Get in touch if something needs to change.');
      }
      const answers = parseAnswers(parseBody(event));

      let saved;
      try {
        saved = await saveAnswers(booking, answers);
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
        // Either the token changed (404 below) or another save landed first on
        // a first submission. Re-read and try once more as an ordinary edit.
        const fresh = await findByToken(token);
        try {
          saved = await saveAnswers(fresh, answers);
        } catch (retryErr) {
          if (retryErr.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'Not found');
          throw retryErr;
        }
      }

      try {
        await notifyBusiness(saved.booking, saved.firstSubmission);
      } catch (err) {
        // The answers are saved; a lost email is a nuisance, not a lost booking.
        console.error('Planning notification email failed:', err);
      }

      return respond(200, { booking: clientView(saved.booking) });
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) return respond(err.statusCode, { error: err.message });
    console.error('Planning form request failed:', err);
    return respond(500, { error: 'Something went wrong' });
  }
};

exports.FIELDS = FIELDS;
exports.FIELD_LABELS = FIELD_LABELS;
exports.isLocked = isLocked;
exports.songsToText = songsToText;
exports.linksToText = linksToText;
exports.dancesToText = dancesToText;
