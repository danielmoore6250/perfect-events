// Tests for the admin bookings API. DynamoDB is stubbed at the document client,
// dispatching on command type, so each test asserts on the exact query, get or
// update the handler issues.

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const HANDLER_PATH = path.join(__dirname, '..', 'index.js');
const TABLE = 'bookings-test';

const loadHandler = ({ table = TABLE } = {}) => {
  delete require.cache[HANDLER_PATH];
  if (table == null) delete process.env.BOOKINGS_TABLE;
  else process.env.BOOKINGS_TABLE = table;
  process.env.USER_POOL_ID = 'eu-west-1_TEST';
  process.env.USER_POOL_CLIENT_ID = 'client123';
  return require(HANDLER_PATH).handler;
};

const request = (method, rawPath, { body, id, claims } = {}) => ({
  rawPath,
  pathParameters: id ? { id } : undefined,
  requestContext: {
    http: { method },
    authorizer: claims ? { jwt: { claims } } : undefined
  },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const booking = (overrides = {}) => ({
  id: 'abc-123',
  recordType: 'booking',
  status: 'enquiry',
  eventDate: '2027-06-12',
  updatedAt: '2026-09-01T10:00:00.000Z',
  client: { name: 'Aoife', email: 'aoife@example.com', phone: '123' },
  statusHistory: [{ status: 'enquiry', at: '2026-09-01T10:00:00.000Z', by: 'website-form' }],
  ...overrides
});

let store;
let commands;

// Splits "a = :a, b = list_append(x, y)" on top-level commas only.
const splitClauses = (expression) => {
  const clauses = [];
  let depth = 0;
  let current = '';
  for (const char of expression) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      clauses.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
};

beforeEach(() => {
  commands = [];
  store = { 'abc-123': booking() };

  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    commands.push(command);
    if (command instanceof QueryCommand) {
      return { Items: Object.values(store) };
    }
    if (command instanceof GetCommand) {
      return { Item: store[command.input.Key.id] };
    }
    if (command instanceof PutCommand) {
      assert.equal(command.input.ConditionExpression, 'attribute_not_exists(id)');
      store[command.input.Item.id] = command.input.Item;
      return {};
    }
    if (command instanceof UpdateCommand && command.input.Key.id === 'settings:calendar') {
      // Emulate SET with if_not_exists on the settings record.
      const values = command.input.ExpressionAttributeValues;
      const existing = store['settings:calendar'] || {};
      const next = { id: 'settings:calendar', ...existing };
      for (const clause of splitClauses(command.input.UpdateExpression.replace(/^SET /, ''))) {
        const [field, expr] = clause.split(' = ');
        const guarded = expr.match(/^if_not_exists\(\w+, (:\w+)\)$/);
        if (guarded) {
          if (next[field] === undefined) next[field] = values[guarded[1]];
        } else {
          next[field] = values[expr];
        }
      }
      store['settings:calendar'] = next;
      return { Attributes: next };
    }
    if (command instanceof UpdateCommand) {
      const item = store[command.input.Key.id];
      if (!item) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      // Apply the update expression the simple way: we know the shape it takes.
      const names = command.input.ExpressionAttributeNames;
      const values = command.input.ExpressionAttributeValues;
      if (values[':expectedUpdatedAt'] !== undefined && item.updatedAt !== values[':expectedUpdatedAt']) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      const next = { ...item };
      for (const clause of splitClauses(command.input.UpdateExpression.replace(/^SET /, ''))) {
        const [target, expr] = clause.split(' = ');
        const field = names[target];
        const guarded = expr.match(/^if_not_exists\(#\w+, (:\w+)\)$/);
        if (expr.startsWith('list_append')) {
          next[field] = [...(item[field] || []), ...values[':historyEntry']];
        } else if (guarded) {
          if (item[field] === undefined) next[field] = values[guarded[1]];
        } else {
          next[field] = values[expr];
        }
      }
      store[command.input.Key.id] = next;
      return { Attributes: next };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });

  mock.method(console, 'error', () => {});
});

afterEach(() => mock.restoreAll());

const updates = () => commands.filter((c) => c instanceof UpdateCommand);

test('GET /admin/config returns the Cognito ids without needing the table', async () => {
  const handler = loadHandler({ table: null });
  const res = await handler(request('GET', '/admin/config'));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    region: 'eu-west-1',
    userPoolId: 'eu-west-1_TEST',
    clientId: 'client123'
  });
});

test('OPTIONS returns 204 with CORS headers', async () => {
  const handler = loadHandler();
  const res = await handler(request('OPTIONS', '/admin/bookings'));

  assert.equal(res.statusCode, 204);
  assert.ok(res.headers['Access-Control-Allow-Headers'].includes('Authorization'));
});

test('GET /admin/bookings queries the ByEventDate index and follows pagination', async () => {
  const handler = loadHandler();
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    commands.push(command);
    call += 1;
    if (call === 1) return { Items: [booking({ id: '1' })], LastEvaluatedKey: { id: '1' } };
    return { Items: [booking({ id: '2' })] };
  });

  const res = await handler(request('GET', '/admin/bookings'));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).bookings.map((b) => b.id), ['1', '2']);

  const queries = commands.filter((c) => c instanceof QueryCommand);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].input.TableName, TABLE);
  assert.equal(queries[0].input.IndexName, 'ByEventDate');
  assert.equal(queries[0].input.KeyConditionExpression, 'recordType = :type');
  assert.equal(queries[0].input.ExclusiveStartKey, undefined);
  assert.deepEqual(queries[1].input.ExclusiveStartKey, { id: '1' });
});

test('GET /admin/bookings/{id} returns the booking', async () => {
  const handler = loadHandler();
  const res = await handler(request('GET', '/admin/bookings/abc-123', { id: 'abc-123' }));

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).booking.client.name, 'Aoife');
});

test('GET /admin/bookings/{id} returns 404 for an unknown id', async () => {
  const handler = loadHandler();
  const res = await handler(request('GET', '/admin/bookings/nope', { id: 'nope' }));

  assert.equal(res.statusCode, 404);
});

test('unknown routes return 404', async () => {
  const handler = loadHandler();
  assert.equal((await handler(request('GET', '/admin/other'))).statusCode, 404);
  assert.equal((await handler(request('DELETE', '/admin/bookings/abc-123', { id: 'abc-123' }))).statusCode, 404);
  assert.equal((await handler(request('PUT', '/admin/bookings'))).statusCode, 404);
});

test('a missing table is a 500 for data routes only', async () => {
  const handler = loadHandler({ table: null });
  const res = await handler(request('GET', '/admin/bookings'));

  assert.equal(res.statusCode, 500);
});

test('PATCH with a status change appends to statusHistory with the admin email', async () => {
  const handler = loadHandler();
  const res = await handler(
    request('PATCH', '/admin/bookings/abc-123', {
      id: 'abc-123',
      body: { status: 'quoted' },
      claims: { email: 'daniel@example.com' }
    })
  );

  assert.equal(res.statusCode, 200);
  const saved = JSON.parse(res.body).booking;
  assert.equal(saved.status, 'quoted');
  assert.equal(saved.statusHistory.length, 2);
  assert.equal(saved.statusHistory[1].status, 'quoted');
  assert.equal(saved.statusHistory[1].by, 'daniel@example.com');
  assert.ok(!Number.isNaN(Date.parse(saved.statusHistory[1].at)));

  const [update] = updates();
  assert.equal(update.input.ConditionExpression, 'attribute_exists(id) AND #updatedAt = :expectedUpdatedAt');
  assert.equal(update.input.ExpressionAttributeValues[':expectedUpdatedAt'], '2026-09-01T10:00:00.000Z');
  assert.ok(update.input.UpdateExpression.includes('list_append(if_not_exists(#statusHistory, :emptyList), :historyEntry)'));
});

test('PATCH with the same status does not add a history entry', async () => {
  const handler = loadHandler();
  const res = await handler(
    request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'enquiry', notes: 'hi' } })
  );

  assert.equal(res.statusCode, 200);
  const saved = JSON.parse(res.body).booking;
  assert.equal(saved.statusHistory.length, 1);
  assert.equal(saved.notes, 'hi');
  assert.ok(!updates()[0].input.UpdateExpression.includes('statusHistory'));
});

test('PATCH falls back to cognito:username then "admin" for the actor', async () => {
  const handler = loadHandler();
  await handler(
    request('PATCH', '/admin/bookings/abc-123', {
      id: 'abc-123',
      body: { status: 'booked' },
      claims: { 'cognito:username': 'dan' }
    })
  );
  assert.equal(store['abc-123'].statusHistory.at(-1).by, 'dan');

  await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'completed' } }));
  assert.equal(store['abc-123'].statusHistory.at(-1).by, 'admin');
});

test('PATCH saves pricing with amounts normalised and missing fields set to null', async () => {
  const handler = loadHandler();
  const res = await handler(
    request('PATCH', '/admin/bookings/abc-123', {
      id: 'abc-123',
      body: { pricing: { quote: '£1,250.505', deposit: 200, depositPaidOn: '2026-10-01' } }
    })
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).booking.pricing, {
    quote: 1250.51,
    deposit: 200,
    depositPaidOn: '2026-10-01',
    balancePaidOn: null
  });
});

test('PATCH updates eventDate and accepts "unknown"', async () => {
  const handler = loadHandler();
  let res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { eventDate: '2027-07-01' } }));
  assert.equal(JSON.parse(res.body).booking.eventDate, '2027-07-01');

  res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { eventDate: 'unknown' } }));
  assert.equal(JSON.parse(res.body).booking.eventDate, 'unknown');
});

test('PATCH clears notes when null or empty', async () => {
  const handler = loadHandler();
  store['abc-123'].notes = 'old';
  const res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { notes: '' } }));

  assert.equal(JSON.parse(res.body).booking.notes, null);
});

test('PATCH rejects bad input with 400 and touches nothing', async () => {
  const handler = loadHandler();
  const bad = [
    [{ status: 'paid' }, /status must be one of/],
    [{ eventDate: '12/06/2027' }, /eventDate must be/],
    [{ eventDate: '2027-13-45' }, /eventDate must be/],
    [{ eventDate: '2027-02-30' }, /eventDate must be/],
    [{ eventDate: '2027-04-31' }, /eventDate must be/],
    [{ pricing: { depositPaidOn: '2027-02-29' } }, /YYYY-MM-DD/],
    [{ pricing: { quote: '£' } }, /non-negative/],
    [{ pricing: { quote: '   ' } }, /non-negative/],
    [{ expectedUpdatedAt: 'yesterday' }, /ISO-8601/],
    [{ expectedUpdatedAt: '2026-09-01T10:00:00.000Z' }, /Nothing to update/],
    [{ notes: 42 }, /notes must be a string/],
    [{ notes: 'x'.repeat(10001) }, /at most 10000/],
    [{ pricing: { quote: -5 } }, /non-negative/],
    [{ pricing: { quote: 'lots' } }, /non-negative/],
    [{ pricing: { depositPaidOn: 'soon' } }, /YYYY-MM-DD/],
    [{ pricing: { balance: 100 } }, /Unknown pricing field/],
    [{ pricing: 'cheap' }, /pricing must be an object/],
    [{ client: { name: 'x' } }, /Unknown field: client/],
    [{}, /Nothing to update/],
    [[], /Body must be a JSON object/]
  ];

  for (const [body, pattern] of bad) {
    const res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(JSON.parse(res.body).error, pattern);
  }
  assert.equal(updates().length, 0);
});

test('PATCH with malformed JSON returns 400', async () => {
  const handler = loadHandler();
  const event = request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123' });
  event.body = '{oops';
  const res = await handler(event);

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /valid JSON/);
});

test('PATCH decodes a base64 body', async () => {
  const handler = loadHandler();
  const event = request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123' });
  event.body = Buffer.from(JSON.stringify({ notes: 'from base64' })).toString('base64');
  event.isBase64Encoded = true;
  const res = await handler(event);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).booking.notes, 'from base64');
});

test('PATCH on an unknown id returns 404 before any write', async () => {
  const handler = loadHandler();
  const res = await handler(request('PATCH', '/admin/bookings/nope', { id: 'nope', body: { status: 'quoted' } }));

  assert.equal(res.statusCode, 404);
  assert.equal(updates().length, 0);
});

test('PATCH accepts a leap day and updates updatedAt', async () => {
  const handler = loadHandler();
  const res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { eventDate: '2028-02-29' } }));

  assert.equal(res.statusCode, 200);
  const saved = JSON.parse(res.body).booking;
  assert.equal(saved.eventDate, '2028-02-29');
  assert.notEqual(saved.updatedAt, '2026-09-01T10:00:00.000Z');
});

test('PATCH with a matching expectedUpdatedAt succeeds and conditions on it', async () => {
  const handler = loadHandler();
  const res = await handler(
    request('PATCH', '/admin/bookings/abc-123', {
      id: 'abc-123',
      body: { notes: 'fresh', expectedUpdatedAt: '2026-09-01T10:00:00.000Z' }
    })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).booking.notes, 'fresh');
  assert.equal(updates()[0].input.ExpressionAttributeValues[':expectedUpdatedAt'], '2026-09-01T10:00:00.000Z');
});

test('PATCH from a stale tab is refused with 409 even when the status still matches', async () => {
  const handler = loadHandler();
  // Another tab saved notes since this tab loaded the record: same status, newer version.
  store['abc-123'].updatedAt = '2026-09-02T08:00:00.000Z';

  const res = await handler(
    request('PATCH', '/admin/bookings/abc-123', {
      id: 'abc-123',
      body: { status: 'quoted', expectedUpdatedAt: '2026-09-01T10:00:00.000Z' }
    })
  );

  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /changed since it was loaded/);
  assert.equal(store['abc-123'].status, 'enquiry');
});

test('PATCH returns 409 when the booking changed between the read and the write', async () => {
  const handler = loadHandler();
  const original = DynamoDBDocumentClient.prototype.send;
  mock.method(DynamoDBDocumentClient.prototype, 'send', async function (command) {
    if (command instanceof GetCommand) return { Item: booking() };
    store['abc-123'].updatedAt = '2026-09-02T08:00:00.000Z';
    return original.call(this, command);
  });

  const res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'booked' } }));

  assert.equal(res.statusCode, 409);
});

test('unexpected errors are a generic 500', async () => {
  const handler = loadHandler();
  mock.method(DynamoDBDocumentClient.prototype, 'send', async () => { throw new Error('boom'); });

  const res = await handler(request('GET', '/admin/bookings'));

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'Something went wrong' });
});

test('GET /admin/calendar creates a long random token on first use and then returns the same one', async () => {
  const handler = loadHandler();

  const first = await handler(request('GET', '/admin/calendar'));
  assert.equal(first.statusCode, 200);
  const { token, rotatedAt } = JSON.parse(first.body).calendar;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!Number.isNaN(Date.parse(rotatedAt)));
  assert.equal(store['settings:calendar'].recordType, 'settings');
  assert.equal(store['settings:calendar'].eventDate, undefined, 'settings must stay out of the ByEventDate index');

  const second = await handler(request('GET', '/admin/calendar'));
  assert.equal(JSON.parse(second.body).calendar.token, token);
});

test('POST /admin/calendar/rotate replaces the token and records who did it', async () => {
  const handler = loadHandler();
  const before = JSON.parse((await handler(request('GET', '/admin/calendar'))).body).calendar.token;

  const res = await handler(request('POST', '/admin/calendar/rotate', { claims: { email: 'daniel@example.com' } }));
  assert.equal(res.statusCode, 200);
  const after = JSON.parse(res.body).calendar.token;

  assert.match(after, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(after, before);
  assert.equal(store['settings:calendar'].calendarToken, after);
  assert.equal(store['settings:calendar'].rotatedBy, 'daniel@example.com');
});

test('calendar routes reject the wrong method', async () => {
  const handler = loadHandler();
  assert.equal((await handler(request('POST', '/admin/calendar'))).statusCode, 404);
  assert.equal((await handler(request('GET', '/admin/calendar/rotate'))).statusCode, 404);
});

test('moving a booking to booked gives it a planning link, and moving it again keeps the same one', async () => {
  const handler = loadHandler();
  let res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'booked' } }));
  assert.equal(res.statusCode, 200);
  const token = JSON.parse(res.body).booking.planningToken;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);

  res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'quoted' } }));
  res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'booked' } }));
  assert.equal(JSON.parse(res.body).booking.planningToken, token, 'an existing link is never replaced by a stage change');
});

test('other stage changes do not create a planning link', async () => {
  const handler = loadHandler();
  const res = await handler(request('PATCH', '/admin/bookings/abc-123', { id: 'abc-123', body: { status: 'quoted' } }));
  assert.equal(JSON.parse(res.body).booking.planningToken, undefined);
});

test('POST /admin/bookings/{id}/planning-link creates a link once and regenerates on request', async () => {
  const handler = loadHandler();
  let res = await handler(request('POST', '/admin/bookings/abc-123/planning-link', { id: 'abc-123', body: {} }));
  assert.equal(res.statusCode, 200);
  const first = JSON.parse(res.body).booking.planningToken;
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);

  res = await handler(request('POST', '/admin/bookings/abc-123/planning-link', { id: 'abc-123', body: {} }));
  assert.equal(JSON.parse(res.body).booking.planningToken, first, 'a plain request keeps the existing link');

  res = await handler(request('POST', '/admin/bookings/abc-123/planning-link', { id: 'abc-123', body: { regenerate: true } }));
  const second = JSON.parse(res.body).booking.planningToken;
  assert.match(second, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(second, first);
  assert.equal(store['abc-123'].planningToken, second);
});

test('POST planning-link on an unknown booking is a 404', async () => {
  const handler = loadHandler();
  const res = await handler(request('POST', '/admin/bookings/nope/planning-link', { id: 'nope', body: {} }));
  assert.equal(res.statusCode, 404);
});

test('POST /admin/bookings creates a booked event by hand with a planning link and history', async () => {
  const handler = loadHandler();
  const res = await handler(
    request('POST', '/admin/bookings', {
      body: {
        name: '  Ciara & Tom ',
        email: 'ciara@example.com',
        phone: '07700 900999',
        eventType: 'wedding',
        weddingPackage: 'after-band',
        eventDate: '2027-08-14',
        venue: 'Clandeboye Lodge',
        guestCount: '180',
        pricing: { quote: '£1,100', deposit: 300, depositPaidOn: '2026-09-20' },
        notes: 'Booked over the phone'
      },
      claims: { email: 'daniel@example.com' }
    })
  );

  assert.equal(res.statusCode, 201);
  const b = JSON.parse(res.body).booking;
  assert.match(b.id, /^[0-9a-f-]{36}$/);
  assert.equal(b.recordType, 'booking');
  assert.equal(b.source, 'admin');
  assert.equal(b.status, 'booked');
  assert.equal(b.eventDate, '2027-08-14');
  assert.deepEqual(b.client, { name: 'Ciara & Tom', email: 'ciara@example.com', phone: '07700 900999' });
  assert.deepEqual(b.event, { type: 'wedding', weddingPackage: 'after-band', venue: 'Clandeboye Lodge', guestCount: '180' });
  assert.deepEqual(b.pricing, { quote: 1100, deposit: 300, depositPaidOn: '2026-09-20', balancePaidOn: null });
  assert.equal(b.notes, 'Booked over the phone');
  assert.deepEqual(b.statusHistory, [{ status: 'booked', at: b.createdAt, by: 'daniel@example.com' }]);
  assert.match(b.planningToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(store[b.id].id, b.id);
});

test('POST /admin/bookings defaults: booked stage, unknown date, no link below booked', async () => {
  const handler = loadHandler();
  let res = await handler(request('POST', '/admin/bookings', { body: { name: 'Sam' } }));
  assert.equal(res.statusCode, 201);
  let b = JSON.parse(res.body).booking;
  assert.equal(b.status, 'booked');
  assert.equal(b.eventDate, 'unknown');
  assert.deepEqual(b.event, { type: null, weddingPackage: null, venue: null, guestCount: null });
  assert.equal(b.pricing, undefined);
  assert.ok(b.planningToken);

  res = await handler(request('POST', '/admin/bookings', { body: { name: 'Sam', status: 'quoted', eventType: 'corporate', weddingPackage: 'full-night' } }));
  b = JSON.parse(res.body).booking;
  assert.equal(b.status, 'quoted');
  assert.equal(b.planningToken, undefined, 'no link until booked');
  assert.equal(b.event.weddingPackage, null, 'package only applies to weddings');
});

test('POST /admin/bookings validates', async () => {
  const handler = loadHandler();
  const bad = [
    [{}, /client name is required/],
    [{ name: '   ' }, /client name is required/],
    [{ name: 'x', status: 'paid' }, /status must be one of/],
    [{ name: 'x', eventDate: '14/08/2027' }, /eventDate must be/],
    [{ name: 'x', eventDate: '2027-02-30' }, /eventDate must be/],
    [{ name: 'x', eventType: 'gig' }, /eventType must be one of/],
    [{ name: 'x', eventType: 'wedding', weddingPackage: 'all-day' }, /weddingPackage must be/],
    [{ name: 'x', guestCount: 'lots' }, /guestCount must be/],
    [{ name: 'x', pricing: { quote: -1 } }, /non-negative/],
    [{ name: 42 }, /must be text/],
    [[], /Body must be a JSON object/]
  ];
  for (const [body, pattern] of bad) {
    const res = await handler(request('POST', '/admin/bookings', { body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(JSON.parse(res.body).error, pattern);
  }
  assert.equal(commands.filter((c) => c instanceof PutCommand).length, 0);
});
