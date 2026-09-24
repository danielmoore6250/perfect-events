// Tests for the client planning form. DynamoDB and SES are stubbed.

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SESv2Client } = require('@aws-sdk/client-sesv2');

const HANDLER_PATH = path.join(__dirname, '..', 'index.js');
const TOKEN = 'planXYZ123_abcdefghijklmnopqrstu';

const loadModule = ({ table = 'bookings-test' } = {}) => {
  delete require.cache[HANDLER_PATH];
  if (table == null) delete process.env.BOOKINGS_TABLE;
  else process.env.BOOKINGS_TABLE = table;
  return require(HANDLER_PATH);
};

const request = (method, token, body) => ({
  requestContext: { http: { method } },
  pathParameters: token === undefined ? undefined : { token },
  body: body === undefined ? undefined : JSON.stringify(body)
});

// Far enough ahead that the lock never kicks in during the test run.
const FUTURE = '2099-06-12';

const booking = (overrides = {}) => ({
  id: 'abc-123',
  recordType: 'booking',
  status: 'booked',
  eventDate: FUTURE,
  updatedAt: '2026-09-24T10:00:00.000Z',
  planningToken: TOKEN,
  client: { name: 'Aoife Murphy', email: 'aoife@example.com', phone: '07700 900123' },
  event: { type: 'wedding', weddingPackage: 'full-night', venue: 'Galgorm Resort', guestCount: '150' },
  pricing: { quote: 1250, deposit: 250, depositPaidOn: null, balancePaidOn: null },
  notes: 'private admin note',
  statusHistory: [{ status: 'booked', at: '2026-09-24T10:00:00.000Z', by: 'admin' }],
  ...overrides
});

let store;
let emails;
let commands;

beforeEach(() => {
  store = { 'abc-123': booking() };
  emails = [];
  commands = [];

  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    commands.push(command);
    if (command instanceof QueryCommand) {
      assert.equal(command.input.IndexName, 'ByPlanningToken');
      const token = command.input.ExpressionAttributeValues[':token'];
      return { Items: Object.values(store).filter((b) => b.planningToken === token) };
    }
    if (command instanceof UpdateCommand) {
      const item = store[command.input.Key.id];
      const values = command.input.ExpressionAttributeValues;
      if (!item || item.planningToken !== values[':token']) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      const next = { ...item, planning: values[':planning'], updatedAt: values[':now'] };
      if (values[':status']) {
        next.status = values[':status'];
        next.statusHistory = [...(item.statusHistory || []), ...values[':entry']];
      }
      store[item.id] = next;
      return { Attributes: next };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });

  mock.method(SESv2Client.prototype, 'send', async (command) => {
    emails.push(command.input);
    return { MessageId: 'm1' };
  });
  mock.method(console, 'error', () => {});
});

afterEach(() => mock.restoreAll());

const updates = () => commands.filter((c) => c instanceof UpdateCommand);

test('GET returns only the client-safe view of the booking', async () => {
  const { handler } = loadModule();
  const res = await handler(request('GET', TOKEN));

  assert.equal(res.statusCode, 200);
  const view = JSON.parse(res.body).booking;
  assert.deepEqual(view, {
    clientName: 'Aoife Murphy',
    eventDate: FUTURE,
    eventDateLabel: 'Friday 12 June 2099',
    eventType: 'wedding',
    eventTypeLabel: 'wedding',
    weddingPackage: 'full-night',
    venue: 'Galgorm Resort',
    guestCount: '150',
    locked: false,
    answers: {},
    submittedAt: null,
    updatedAt: null
  });
  const raw = res.body;
  for (const secret of ['aoife@example.com', '07700', '1250', 'private admin note', 'statusHistory', 'planningToken', TOKEN]) {
    assert.ok(!raw.includes(secret), `response leaks ${secret}`);
  }
});

test('a wrong, short, or missing token is a 404', async () => {
  const { handler } = loadModule();
  for (const token of ['nope', `${TOKEN}x`, 'short', '', undefined, 'has spaces in it and more']) {
    const res = await handler(request('GET', token));
    assert.equal(res.statusCode, 404, JSON.stringify(token));
  }
});

test('a token that matches a non-booking record is a 404', async () => {
  const { handler } = loadModule();
  store = { settings: { id: 'settings:calendar', recordType: 'settings', planningToken: TOKEN } };
  assert.equal((await handler(request('GET', TOKEN))).statusCode, 404);
});

test('OPTIONS and unknown methods', async () => {
  const { handler } = loadModule();
  assert.equal((await handler(request('OPTIONS', TOKEN))).statusCode, 204);
  assert.equal((await handler(request('DELETE', TOKEN))).statusCode, 404);
  assert.equal((await handler(request('PATCH', TOKEN, {}))).statusCode, 404);
});

test('first POST saves answers, moves booked to details-received, and emails the business', async () => {
  const { handler } = loadModule();
  const answers = {
    guestArrivalTime: '18:00',
    djStartTime: '19:30',
    finishTime: '00:00',
    firstDance: 'Perfect - Ed Sheeran',
    mustPlay: 'Mr Brightside\nDancing Queen',
    doNotPlay: '  Cha Cha Slide  ',
    venueContactName: 'Sam',
    extraNotes: ''
  };
  const res = await handler(request('POST', TOKEN, { answers }));

  assert.equal(res.statusCode, 200);
  const view = JSON.parse(res.body).booking;
  assert.deepEqual(view.answers, {
    guestArrivalTime: '18:00',
    djStartTime: '19:30',
    finishTime: '00:00',
    firstDance: 'Perfect - Ed Sheeran',
    mustPlay: 'Mr Brightside\nDancing Queen',
    doNotPlay: 'Cha Cha Slide',
    venueContactName: 'Sam'
  });
  assert.ok(view.submittedAt && view.updatedAt);

  const saved = store['abc-123'];
  assert.equal(saved.status, 'details-received');
  assert.deepEqual(saved.statusHistory.at(-1).status, 'details-received');
  assert.equal(saved.statusHistory.at(-1).by, 'client-planning-form');
  assert.equal(saved.planning.submittedAt, saved.planning.updatedAt);

  const [update] = updates();
  assert.equal(update.input.ConditionExpression, 'attribute_exists(id) AND #planningToken = :token');

  assert.equal(emails.length, 1);
  const email = emails[0];
  assert.deepEqual(email.Destination.ToAddresses, ['enquiries@perfecteventsni.com']);
  assert.match(email.Content.Simple.Subject.Data, /^Planning details received: Aoife Murphy, Friday 12 June 2099$/);
  assert.ok(email.Content.Simple.Body.Html.Data.includes('Perfect - Ed Sheeran'));
  assert.ok(email.Content.Simple.Body.Html.Data.includes('Mr Brightside<br>Dancing Queen'));
  assert.ok(email.Content.Simple.Body.Html.Data.includes('https://perfecteventsni.com/admin/abc-123'));
  assert.ok(email.Content.Simple.Body.Text.Data.includes('First dance: Perfect - Ed Sheeran'));
});

test('a second POST updates answers, keeps the original submittedAt, and does not change status again', async () => {
  const { handler } = loadModule();
  await handler(request('POST', TOKEN, { answers: { firstDance: 'A' } }));
  const firstSubmittedAt = store['abc-123'].planning.submittedAt;
  store['abc-123'].status = 'details-received';

  const res = await handler(request('POST', TOKEN, { answers: { firstDance: 'B', lastSong: 'C' } }));

  assert.equal(res.statusCode, 200);
  const saved = store['abc-123'];
  assert.deepEqual(saved.planning.answers, { firstDance: 'B', lastSong: 'C' });
  assert.equal(saved.planning.submittedAt, firstSubmittedAt);
  assert.equal(saved.statusHistory.length, 2, 'no extra history entry on edit');
  assert.match(emails[1].Content.Simple.Subject.Data, /^Planning details updated:/);
});

test('a first submission on a completed or enquiry booking saves but leaves the status alone', async () => {
  const { handler } = loadModule();
  for (const status of ['enquiry', 'quoted', 'details-received', 'completed', 'lost']) {
    store = { 'abc-123': booking({ status }) };
    const res = await handler(request('POST', TOKEN, { answers: { lastSong: 'X' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(store['abc-123'].status, status);
  }
  store = { 'abc-123': booking({ status: 'details-requested' }) };
  await handler(request('POST', TOKEN, { answers: { lastSong: 'X' } }));
  assert.equal(store['abc-123'].status, 'details-received');
});

test('HTML in answers is escaped in the email', async () => {
  const { handler } = loadModule();
  await handler(request('POST', TOKEN, { answers: { firstDance: '<script>alert(1)</script>' } }));
  const html = emails[0].Content.Simple.Body.Html.Data;
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('POST validation rejects bad input with 400 and saves nothing', async () => {
  const { handler } = loadModule();
  const bad = [
    [{}, /answers must be an object/],
    [{ answers: [] }, /answers must be an object/],
    [{ answers: { favouriteColour: 'blue' } }, /Unknown field/],
    [{ answers: { firstDance: 42 } }, /must be text/],
    [{ answers: { djStartTime: '7pm' } }, /time like 19:30/],
    [{ answers: { djStartTime: '25:00' } }, /time like 19:30/],
    [{ answers: { firstDance: 'x'.repeat(201) } }, /too long/],
    [{ answers: { mustPlay: 'x'.repeat(3001) } }, /too long/],
    [[], /Body must be a JSON object/]
  ];
  for (const [body, pattern] of bad) {
    const res = await handler(request('POST', TOKEN, body));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(JSON.parse(res.body).error, pattern);
  }
  assert.equal(updates().length, 0);
  assert.equal(emails.length, 0);
});

test('an empty answers object is accepted and clears previous answers', async () => {
  const { handler } = loadModule();
  store['abc-123'].planning = { answers: { firstDance: 'old' }, submittedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const res = await handler(request('POST', TOKEN, { answers: {} }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(store['abc-123'].planning.answers, {});
});

test('malformed JSON is a 400', async () => {
  const { handler } = loadModule();
  const event = request('POST', TOKEN);
  event.body = '{nope';
  assert.equal((await handler(event)).statusCode, 400);
});

test('the form locks three days before the event and stays locked afterwards', async () => {
  const { handler, isLocked } = loadModule();
  const now = new Date('2027-06-09T09:00:00Z');
  assert.equal(isLocked('2027-06-13', now), false, '4 days out is open');
  assert.equal(isLocked('2027-06-12', now), true, '3 days out is locked');
  assert.equal(isLocked('2027-06-09', now), true, 'event day is locked');
  assert.equal(isLocked('2027-06-01', now), true, 'past is locked');
  assert.equal(isLocked('unknown', now), false, 'no date means no lock');

  store = { 'abc-123': booking({ eventDate: '2020-01-01' }) };
  const get = await handler(request('GET', TOKEN));
  assert.equal(JSON.parse(get.body).booking.locked, true);

  const post = await handler(request('POST', TOKEN, { answers: { lastSong: 'X' } }));
  assert.equal(post.statusCode, 423);
  assert.match(JSON.parse(post.body).error, /locked/);
  assert.equal(updates().length, 0);
});

test('a save after the link was regenerated is a 404, not an overwrite', async () => {
  const { handler } = loadModule();
  const original = DynamoDBDocumentClient.prototype.send;
  mock.method(DynamoDBDocumentClient.prototype, 'send', async function (command) {
    if (command instanceof QueryCommand) return { Items: [booking()] };
    store['abc-123'].planningToken = 'rotated_token_000000000000000';
    return original.call(this, command);
  });
  const res = await handler(request('POST', TOKEN, { answers: { lastSong: 'X' } }));
  assert.equal(res.statusCode, 404);
});

test('an email failure does not fail the save', async () => {
  const { handler } = loadModule();
  mock.method(SESv2Client.prototype, 'send', async () => { throw new Error('SES down'); });
  const res = await handler(request('POST', TOKEN, { answers: { lastSong: 'X' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(store['abc-123'].planning.answers.lastSong, 'X');
});

test('a missing table or a DynamoDB failure never leaks details', async () => {
  let { handler } = loadModule({ table: null });
  assert.equal((await handler(request('GET', TOKEN))).statusCode, 404);
  ({ handler } = loadModule());
  mock.method(DynamoDBDocumentClient.prototype, 'send', async () => { throw new Error('boom'); });
  const res = await handler(request('GET', TOKEN));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'Something went wrong' });
});
