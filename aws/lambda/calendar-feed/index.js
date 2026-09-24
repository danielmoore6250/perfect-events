// Calendar feed: GET /calendar/{token}.ics
//
// Returns every booking at the 'booked' stage or later as an all-day iCalendar
// event, so the phone's calendar app can subscribe once and stay in sync. The
// token is the only protection, so it is long, random, compared in constant
// time, and rotatable from the admin screen. A wrong token is a 404 that looks
// identical to a missing route.

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'eu-west-1';
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const SETTINGS_ID = 'settings:calendar';
const BY_EVENT_DATE_INDEX = 'ByEventDate';
const ADMIN_URL = 'https://perfecteventsni.com/admin';

// Only confirmed work goes on the calendar. Enquiries and quotes are not
// commitments; lost ones never happened.
const CALENDAR_STATUSES = new Set(['booked', 'details-requested', 'details-received', 'completed']);

const EVENT_TYPE_LABELS = {
  wedding: 'Wedding',
  private: 'Private event',
  corporate: 'Corporate event',
  'pa-hire': 'PA hire'
};
const WEDDING_PACKAGE_LABELS = {
  'full-night': 'Full night',
  'after-band': 'After band',
  'not-sure': 'Package TBC'
};

// ---- iCalendar formatting ------------------------------------------------

// RFC 5545 text escaping: backslash, semicolon, comma and newlines. Each
// replacement is one literal backslash then the character, so the backslash
// is doubled in this source.
const escapeText = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded with CRLF + space. Folding is done on
// bytes, so a multi-byte character is never split.
const foldLine = (line) => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back up to a UTF-8 character boundary (continuation bytes are 10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // the leading space on continuation lines counts
  }
  return parts.join('\r\n ');
};

const compactDate = (iso) => iso.replace(/-/g, '');

const nextDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return date.toISOString().slice(0, 10);
};

const dtstamp = (iso) => {
  const date = new Date(iso);
  const stamp = Number.isNaN(date.getTime()) ? new Date() : date;
  return stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

// Strict YYYY-MM-DD: the enquiry form can store a value like 2027-02-30 that
// only looks like a date, and a booking is never revalidated when its stage
// changes, so the feed must not emit it as a DTSTART.
const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const formatMoney = (amount) => (typeof amount === 'number' ? `£${amount.toFixed(2)}` : null);

const describe = (b) => {
  const client = b.client || {};
  const event = b.event || {};
  const pricing = b.pricing || {};
  const lines = [];

  lines.push(`Client: ${client.name || 'Unknown'}`);
  if (client.phone) lines.push(`Phone: ${client.phone}`);
  if (client.email) lines.push(`Email: ${client.email}`);
  if (event.type === 'wedding' && event.weddingPackage) {
    lines.push(`Package: ${WEDDING_PACKAGE_LABELS[event.weddingPackage] || event.weddingPackage}`);
  }
  if (event.guestCount) lines.push(`Guests: ${event.guestCount}`);

  const quote = formatMoney(pricing.quote);
  if (quote) {
    const deposit = typeof pricing.deposit === 'number' ? pricing.deposit : 0;
    const balance = formatMoney(Math.max(pricing.quote - deposit, 0));
    const paid = pricing.balancePaidOn ? 'paid' : `${balance} due`;
    lines.push(`Quote: ${quote} (balance ${paid})`);
  }

  lines.push(`Stage: ${b.status}`);

  // Timings the client gave on their planning form, once they have.
  const answers = b.planning?.answers || {};
  const timings = [
    ['Set-up from', answers.setupAccessTime],
    ['Guests', answers.guestArrivalTime],
    ['Meal', answers.mealTime],
    ['Speeches', answers.speechesTime],
    ['DJ', answers.djStartTime],
    ['Finish', answers.finishTime]
  ].filter(([, value]) => value);
  if (timings.length) lines.push(`Timings: ${timings.map(([label, value]) => `${label} ${value}`).join(', ')}`);
  if (answers.firstDance) lines.push(`First dance: ${answers.firstDance}`);
  if (answers.venueContactName || answers.venueContactPhone) {
    lines.push(`Venue contact: ${[answers.venueContactName, answers.venueContactPhone].filter(Boolean).join(' ')}`);
  }

  if (b.notes) lines.push('', b.notes);
  lines.push('', `${ADMIN_URL}/${b.id}`);
  return lines.join('\n');
};

const toEvent = (b) => {
  const client = b.client || {};
  const event = b.event || {};
  const typeLabel = EVENT_TYPE_LABELS[event.type] || 'Event';
  const summary = `${typeLabel}: ${client.name || 'Unknown client'}`;

  const props = [
    'BEGIN:VEVENT',
    `UID:${b.id}@perfecteventsni.com`,
    `DTSTAMP:${dtstamp(b.updatedAt || b.createdAt)}`,
    `DTSTART;VALUE=DATE:${compactDate(b.eventDate)}`,
    `DTEND;VALUE=DATE:${compactDate(nextDay(b.eventDate))}`,
    `SUMMARY:${escapeText(summary)}`
  ];
  if (event.venue) props.push(`LOCATION:${escapeText(event.venue)}`);
  props.push(`DESCRIPTION:${escapeText(describe(b))}`);
  props.push(`URL:${ADMIN_URL}/${b.id}`);
  props.push('STATUS:CONFIRMED');
  props.push('END:VEVENT');
  return props;
};

const buildCalendar = (bookings) => {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Perfect Events NI//Bookings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Perfect Events NI bookings',
    'X-PUBLISHED-TTL:PT1H'
  ];
  for (const b of bookings) lines.push(...toEvent(b));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
};

// ---- Data access ----------------------------------------------------------

const getCalendarToken = async () => {
  const { Item } = await docClient.send(new GetCommand({ TableName: BOOKINGS_TABLE, Key: { id: SETTINGS_ID } }));
  return Item?.calendarToken || null;
};

const tokenMatches = (expected, given) => {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const listCalendarBookings = async () => {
  const bookings = [];
  let ExclusiveStartKey;
  do {
    const page = await docClient.send(
      new QueryCommand({
        TableName: BOOKINGS_TABLE,
        IndexName: BY_EVENT_DATE_INDEX,
        KeyConditionExpression: 'recordType = :type',
        ExpressionAttributeValues: { ':type': 'booking' },
        ExclusiveStartKey
      })
    );
    bookings.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return bookings.filter((b) => CALENDAR_STATUSES.has(b.status) && isIsoDate(b.eventDate));
};

// ---- Handler --------------------------------------------------------------

const notFound = () => ({
  statusCode: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: 'Not found'
});

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method !== 'GET') return notFound();

  const given = String(event.pathParameters?.token || '').replace(/\.ics$/i, '');
  if (!given || !BOOKINGS_TABLE) return notFound();

  try {
    const expected = await getCalendarToken();
    if (!tokenMatches(expected, given)) return notFound();

    const body = buildCalendar(await listCalendarBookings());
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="perfect-events-bookings.ics"',
        'Cache-Control': 'private, max-age=300'
      },
      body
    };
  } catch (err) {
    console.error('Calendar feed failed:', err);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Something went wrong' };
  }
};

exports.buildCalendar = buildCalendar;
exports.foldLine = foldLine;
