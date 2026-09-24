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
//   time:  HH:MM, 24-hour
//   short: single line
//   long:  free text
const FIELDS = {
  setupAccessTime: { type: 'time' },
  guestArrivalTime: { type: 'time' },
  mealTime: { type: 'time' },
  speechesTime: { type: 'time' },
  djStartTime: { type: 'time' },
  finishTime: { type: 'time' },
  firstDance: { type: 'short' },
  parentDances: { type: 'short' },
  lastSong: { type: 'short' },
  mustPlay: { type: 'long' },
  doNotPlay: { type: 'long' },
  musicStyle: { type: 'long' },
  announcements: { type: 'long' },
  venueContactName: { type: 'short' },
  venueContactPhone: { type: 'short' },
  accessNotes: { type: 'long' },
  extraNotes: { type: 'long' }
};
const MAX_LENGTH = { time: 5, short: 200, long: 3000 };

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
  setupAccessTime: 'Set-up access from',
  guestArrivalTime: 'Guests arrive',
  mealTime: 'Meal served',
  speechesTime: 'Speeches',
  djStartTime: 'DJ starts',
  finishTime: 'Music finishes',
  firstDance: 'First dance',
  parentDances: 'Parent dances',
  lastSong: 'Last song',
  mustPlay: 'Must play',
  doNotPlay: 'Do not play',
  musicStyle: 'Music style',
  announcements: 'Announcements',
  venueContactName: 'Venue contact',
  venueContactPhone: 'Venue phone',
  accessNotes: 'Access notes',
  extraNotes: 'Anything else'
};

const notifyBusiness = async (booking, firstSubmission) => {
  const name = booking.client?.name || 'Unknown client';
  const when = formatEventDate(booking.eventDate);
  const subject = `${firstSubmission ? 'Planning details received' : 'Planning details updated'}: ${name}, ${when}`;
  const link = `${ADMIN_URL}/${booking.id}`;
  const answers = booking.planning?.answers || {};

  const rows = Object.keys(FIELDS)
    .filter((key) => answers[key])
    .map((key) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(FIELD_LABELS[key])}</td><td style="padding:6px 0">${esc(answers[key]).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  const text = Object.keys(FIELDS)
    .filter((key) => answers[key])
    .map((key) => `${FIELD_LABELS[key]}: ${answers[key]}`)
    .join('\n');

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
