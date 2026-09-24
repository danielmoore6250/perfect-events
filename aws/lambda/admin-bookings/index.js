// Admin API for the bookings table. Every route except /admin/config sits
// behind the Cognito JWT authorizer in API Gateway, so by the time a request
// reaches this code the caller has already proved they are the admin user.
//
// Routes (HTTP API v2 payloads):
//   GET   /admin/config            public: Cognito ids the login screen needs
//   GET   /admin/bookings          every booking, oldest event date first
//   GET   /admin/bookings/{id}     one booking
//   PATCH /admin/bookings/{id}     update status, eventDate, pricing and notes
//   POST  /admin/bookings/{id}/planning-link  give the booking a client planning
//                                  link (or replace it with { "regenerate": true })
//   GET   /admin/calendar          the calendar feed token (created on first use)
//   POST  /admin/calendar/rotate   replace the token, invalidating the old feed URL

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'eu-west-1';
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const BY_EVENT_DATE_INDEX = 'ByEventDate';

// One settings record holds the calendar feed token. It has no eventDate, so
// it never appears in the ByEventDate index alongside bookings.
const CALENDAR_SETTINGS_ID = 'settings:calendar';

// The stages a booking moves through. Order matters only for display.
const STATUSES = [
  'enquiry',
  'quoted',
  'booked',
  'details-requested',
  'details-received',
  'completed',
  'lost'
];

const PRICING_FIELDS = ['quote', 'deposit', 'depositPaidOn', 'balancePaidOn'];
const MONEY_FIELDS = new Set(['quote', 'deposit']);
const DATE_FIELDS = new Set(['depositPaidOn', 'balancePaidOn']);
const MAX_NOTES_LENGTH = 10000;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Content-Type': 'application/json'
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body)
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Strict YYYY-MM-DD: Date.parse would happily turn 2027-02-30 into 2 March, so
// the components are checked against what the Date actually resolved to.
const isIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

// ---- Validation -----------------------------------------------------------

// Turns a request body into the set of fields that may change. Anything not
// recognised is an error rather than silently dropped, so a typo in the client
// never looks like a successful save. `expectedUpdatedAt` is not a change: it is
// the version the caller edited, used to refuse a save over someone else's.
const parseUpdate = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }

  const changes = {};
  let expectedUpdatedAt = null;

  for (const key of Object.keys(body)) {
    const value = body[key];

    switch (key) {
      case 'expectedUpdatedAt':
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          throw new HttpError(400, 'expectedUpdatedAt must be an ISO-8601 timestamp');
        }
        expectedUpdatedAt = value;
        break;

      case 'status':
        if (!STATUSES.includes(value)) {
          throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
        }
        changes.status = value;
        break;

      case 'eventDate':
        if (value !== 'unknown' && !isIsoDate(value)) {
          throw new HttpError(400, 'eventDate must be YYYY-MM-DD or "unknown"');
        }
        changes.eventDate = value;
        break;

      case 'notes':
        if (value !== null && typeof value !== 'string') {
          throw new HttpError(400, 'notes must be a string or null');
        }
        if (value && value.length > MAX_NOTES_LENGTH) {
          throw new HttpError(400, `notes must be at most ${MAX_NOTES_LENGTH} characters`);
        }
        changes.notes = value || null;
        break;

      case 'pricing':
        changes.pricing = parsePricing(value);
        break;

      default:
        throw new HttpError(400, `Unknown field: ${key}`);
    }
  }

  if (Object.keys(changes).length === 0) {
    throw new HttpError(400, 'Nothing to update');
  }

  return { changes, expectedUpdatedAt };
};

const parsePricing = (pricing) => {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw new HttpError(400, 'pricing must be an object');
  }

  const clean = {};
  for (const key of Object.keys(pricing)) {
    if (!PRICING_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown pricing field: ${key}`);
    }
    const value = pricing[key];

    if (value === null || value === '') {
      clean[key] = null;
    } else if (MONEY_FIELDS.has(key)) {
      const text = typeof value === 'number' ? String(value) : String(value).replace(/[£,\s]/g, '');
      const amount = text === '' ? NaN : Number(text);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new HttpError(400, `pricing.${key} must be a non-negative amount`);
      }
      clean[key] = Math.round(amount * 100) / 100;
    } else if (DATE_FIELDS.has(key)) {
      if (!isIsoDate(value)) {
        throw new HttpError(400, `pricing.${key} must be YYYY-MM-DD`);
      }
      clean[key] = value;
    }
  }

  // Every pricing field is always present on the record so the admin screen
  // never has to guess whether a missing key means "unset" or "old record".
  for (const key of PRICING_FIELDS) {
    if (!(key in clean)) clean[key] = null;
  }
  return clean;
};

// ---- Data access ----------------------------------------------------------

const listBookings = async () => {
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

  return bookings;
};

const getBooking = async (id) => {
  const { Item } = await docClient.send(new GetCommand({ TableName: BOOKINGS_TABLE, Key: { id } }));
  if (!Item) throw new HttpError(404, 'Booking not found');
  return Item;
};

// `expectedUpdatedAt` is the version the caller loaded. If it is omitted the
// version this request just read is used instead, which still stops two
// simultaneous saves but cannot catch a tab that loaded the record long ago.
const updateBooking = async (id, changes, actor, expectedUpdatedAt) => {
  const current = await getBooking(id);
  const now = new Date().toISOString();

  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':updatedAt': now, ':expectedUpdatedAt': expectedUpdatedAt || current.updatedAt };
  const sets = ['#updatedAt = :updatedAt'];

  const statusChanged = changes.status !== undefined && changes.status !== current.status;

  if (statusChanged) {
    names['#status'] = 'status';
    names['#statusHistory'] = 'statusHistory';
    values[':status'] = changes.status;
    values[':historyEntry'] = [{ status: changes.status, at: now, by: actor }];
    values[':emptyList'] = [];
    sets.push('#status = :status');
    sets.push('#statusHistory = list_append(if_not_exists(#statusHistory, :emptyList), :historyEntry)');

    // Reaching 'booked' is when the client gets their planning link, so make
    // sure one exists. Never replaces a link that is already out there.
    if (changes.status === 'booked') {
      names['#planningToken'] = 'planningToken';
      values[':planningToken'] = newToken();
      sets.push('#planningToken = if_not_exists(#planningToken, :planningToken)');
    }
  }

  for (const field of ['eventDate', 'notes', 'pricing']) {
    if (changes[field] !== undefined) {
      names[`#${field}`] = field;
      values[`:${field}`] = changes[field];
      sets.push(`#${field} = :${field}`);
    }
  }

  try {
    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: BOOKINGS_TABLE,
        Key: { id },
        UpdateExpression: `SET ${sets.join(', ')}`,
        // A stale save fails rather than silently overwriting a change made
        // from another tab: the record must still be the version the caller saw.
        ConditionExpression: 'attribute_exists(id) AND #updatedAt = :expectedUpdatedAt',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW'
      })
    );
    return Attributes;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'Booking changed since it was loaded. Reload and try again.');
    }
    throw err;
  }
};

// 192 random bits, URL-safe. Long enough that a URL cannot be guessed.
const newToken = () => crypto.randomBytes(24).toString('base64url');
const newCalendarToken = newToken;

// Gives a booking its planning link. Creates one if missing; with regenerate
// the old link stops working. Returns the updated booking.
const setPlanningLink = async (id, { regenerate = false } = {}) => {
  await getBooking(id);
  const now = new Date().toISOString();
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: BOOKINGS_TABLE,
      Key: { id },
      UpdateExpression: regenerate
        ? 'SET #planningToken = :token, #updatedAt = :now'
        : 'SET #planningToken = if_not_exists(#planningToken, :token), #updatedAt = :now',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeNames: { '#planningToken': 'planningToken', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':token': newToken(), ':now': now },
      ReturnValues: 'ALL_NEW'
    })
  );
  return Attributes;
};

const calendarView = (item) => ({
  token: item.calendarToken,
  rotatedAt: item.rotatedAt || item.createdAt || null
});

// Returns the token, creating it the first time the admin asks. UpdateItem
// with if_not_exists means two simultaneous first requests still agree.
const getCalendarSettings = async () => {
  const now = new Date().toISOString();
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: BOOKINGS_TABLE,
      Key: { id: CALENDAR_SETTINGS_ID },
      UpdateExpression:
        'SET recordType = if_not_exists(recordType, :type), calendarToken = if_not_exists(calendarToken, :token), createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':type': 'settings', ':token': newCalendarToken(), ':now': now },
      ReturnValues: 'ALL_NEW'
    })
  );
  return calendarView(Attributes);
};

const rotateCalendarToken = async (actor) => {
  const now = new Date().toISOString();
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: BOOKINGS_TABLE,
      Key: { id: CALENDAR_SETTINGS_ID },
      UpdateExpression:
        'SET recordType = :type, calendarToken = :token, rotatedAt = :now, rotatedBy = :actor, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':type': 'settings', ':token': newCalendarToken(), ':now': now, ':actor': actor },
      ReturnValues: 'ALL_NEW'
    })
  );
  return calendarView(Attributes);
};

// ---- Handler --------------------------------------------------------------

const actorFrom = (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  return claims.email || claims['cognito:username'] || 'admin';
};

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
  const rawPath = event.rawPath || event.path || '';
  const path = rawPath.replace(/\/+$/, '') || '/';
  const id = event.pathParameters?.id;

  if (method === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  try {
    if (method === 'GET' && path === '/admin/config') {
      return respond(200, {
        region: REGION,
        userPoolId: process.env.USER_POOL_ID || null,
        clientId: process.env.USER_POOL_CLIENT_ID || null
      });
    }

    if (!BOOKINGS_TABLE) throw new HttpError(500, 'BOOKINGS_TABLE is not configured');

    if (method === 'GET' && path === '/admin/bookings') {
      return respond(200, { bookings: await listBookings() });
    }

    if (method === 'GET' && path === '/admin/calendar') {
      return respond(200, { calendar: await getCalendarSettings() });
    }

    if (method === 'POST' && path === '/admin/calendar/rotate') {
      return respond(200, { calendar: await rotateCalendarToken(actorFrom(event)) });
    }

    if (id && method === 'POST' && path === `/admin/bookings/${id}/planning-link`) {
      const body = parseBody(event);
      const booking = await setPlanningLink(id, { regenerate: body.regenerate === true });
      return respond(200, { booking });
    }

    if (id && path === `/admin/bookings/${id}`) {
      if (method === 'GET') {
        return respond(200, { booking: await getBooking(id) });
      }
      if (method === 'PATCH') {
        const { changes, expectedUpdatedAt } = parseUpdate(parseBody(event));
        const booking = await updateBooking(id, changes, actorFrom(event), expectedUpdatedAt);
        return respond(200, { booking });
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) {
      return respond(err.statusCode, { error: err.message });
    }
    console.error('Admin request failed:', err);
    return respond(500, { error: 'Something went wrong' });
  }
};

exports.STATUSES = STATUSES;
