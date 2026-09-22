// Tests for the enquiry handler. Runs with Node's built-in test runner
// (`npm test` in this directory) — no extra dependencies, so nothing new ends
// up in the Lambda bundle.
//
// DynamoDB is stubbed at the document client and email at the nodemailer
// transport, so each test can inspect the exact record written and the exact
// HTML that would have gone out.

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const nodemailer = require('nodemailer');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const HANDLER_PATH = path.join(__dirname, '..', 'index.js');
const TABLE = 'perfect-events-bookings-test';

// index.js reads BOOKINGS_TABLE at load time, so the module is re-required for
// each test with the environment it should see.
const loadHandler = ({ table = TABLE } = {}) => {
  delete require.cache[HANDLER_PATH];
  if (table == null) delete process.env.BOOKINGS_TABLE;
  else process.env.BOOKINGS_TABLE = table;
  return require(HANDLER_PATH).handler;
};

const postEvent = (body) => ({
  requestContext: { http: { method: 'POST' } },
  body: JSON.stringify(body)
});

const fullEnquiry = {
  name: 'Aoife Murphy',
  email: 'aoife@example.com',
  phone: '07700 900123',
  eventType: 'wedding',
  weddingPackage: 'full-night',
  eventDate: '2027-06-12',
  venue: 'Galgorm Resort',
  guestCount: '150',
  message: 'First dance is Perfect by Ed Sheeran.\nNo Mr Brightside please.'
};

let putItems;
let sentMail;
let dynamoSend;
let sendMail;

beforeEach(() => {
  putItems = [];
  sentMail = [];

  dynamoSend = mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    assert.ok(command instanceof PutCommand, 'only PutCommand is expected');
    putItems.push(command.input);
    return {};
  });

  sendMail = mock.fn(async (options) => {
    sentMail.push(options);
    return { messageId: `test-${sentMail.length}` };
  });
  mock.method(nodemailer, 'createTransport', () => ({ sendMail }));

  // Keep test output readable; the handler logs on every step.
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  mock.restoreAll();
});

const businessMail = () => sentMail.find((m) => m.to === 'enquiries@perfecteventsni.com');
const clientMail = () => sentMail.find((m) => m.to !== 'enquiries@perfecteventsni.com');

test('CORS preflight returns 200 with the CORS headers', async () => {
  const handler = loadHandler();
  const res = await handler({ requestContext: { http: { method: 'OPTIONS' } } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(putItems.length, 0);
  assert.equal(sentMail.length, 0);
});

test('non-POST methods are rejected with 405', async () => {
  const handler = loadHandler();
  const res = await handler({ requestContext: { http: { method: 'GET' } } });

  assert.equal(res.statusCode, 405);
  assert.equal(putItems.length, 0);
  assert.equal(sentMail.length, 0);
});

test('missing required fields return 400 and record nothing', async () => {
  const handler = loadHandler();
  const res = await handler(postEvent({ name: 'Aoife', email: 'aoife@example.com' }));

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'Missing required fields' });
  assert.equal(putItems.length, 0);
  assert.equal(sentMail.length, 0);
});

test('whitespace-only required fields count as missing', async () => {
  const handler = loadHandler();
  const res = await handler(postEvent({ name: '   ', email: 'a@b.com', phone: '123' }));

  assert.equal(res.statusCode, 400);
  assert.equal(putItems.length, 0);
});

test('malformed JSON body returns 500 without throwing', async () => {
  const handler = loadHandler();
  const res = await handler({ requestContext: { http: { method: 'POST' } }, body: '{not json' });

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, 'Failed to send enquiry');
});

test('a full wedding enquiry writes the booking record and sends both emails', async () => {
  const handler = loadHandler();
  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { success: true, message: 'Enquiry sent successfully' });

  assert.equal(putItems.length, 1);
  const { TableName, Item } = putItems[0];
  assert.equal(TableName, TABLE);

  assert.match(Item.id, /^[0-9a-f-]{36}$/);
  assert.equal(Item.recordType, 'booking');
  assert.equal(Item.status, 'enquiry');
  assert.equal(Item.source, 'website');
  assert.equal(Item.eventDate, '2027-06-12');
  assert.equal(Item.createdAt, Item.updatedAt);
  assert.ok(!Number.isNaN(Date.parse(Item.createdAt)));

  assert.deepEqual(Item.client, {
    name: 'Aoife Murphy',
    email: 'aoife@example.com',
    phone: '07700 900123'
  });
  assert.deepEqual(Item.event, {
    type: 'wedding',
    weddingPackage: 'full-night',
    venue: 'Galgorm Resort',
    guestCount: '150'
  });
  assert.equal(Item.message, fullEnquiry.message);
  assert.deepEqual(Item.statusHistory, [{ status: 'enquiry', at: Item.createdAt, by: 'website-form' }]);

  assert.equal(sentMail.length, 2);
  const business = businessMail();
  const client = clientMail();

  assert.equal(business.subject, 'New Enquiry from Aoife Murphy - Wedding');
  assert.equal(client.to, 'aoife@example.com');
  assert.equal(client.subject, 'We Received Your Enquiry - Perfect Events NI');

  // The booking reference in the email is the first 8 chars of the record id.
  assert.ok(business.html.includes(`Booking reference: ${Item.id.slice(0, 8).toUpperCase()}`));

  // Labels, not raw form values, appear in the email.
  assert.ok(business.html.includes('Full Night'));
  assert.ok(business.html.includes('12 June 2027'));
  assert.ok(business.html.includes('Galgorm Resort'));
  assert.ok(client.html.includes('Hi Aoife Murphy,'));
  assert.ok(client.html.includes('considering Perfect Events NI for your wedding.'));
});

test('the record is written before any email is sent', async () => {
  const handler = loadHandler();
  const order = [];
  dynamoSend.mock.mockImplementation(async () => { order.push('dynamo'); return {}; });
  sendMail.mock.mockImplementation(async () => { order.push('email'); return {}; });

  await handler(postEvent(fullEnquiry));

  assert.deepEqual(order, ['dynamo', 'email', 'email']);
});

test('HTML in client input is escaped in both emails but stored verbatim', async () => {
  const handler = loadHandler();
  const hostile = {
    ...fullEnquiry,
    name: '<script>alert("x")</script>',
    venue: 'The "Grand" & Co',
    message: "<img src=x onerror='alert(1)'>"
  };
  await handler(postEvent(hostile));

  for (const mail of sentMail) {
    assert.ok(!mail.html.includes('<script>'), `${mail.to} contains a raw <script> tag`);
    assert.ok(!mail.html.includes('<img src=x'), `${mail.to} contains a raw <img> tag`);
  }
  assert.ok(businessMail().html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(businessMail().html.includes('The &quot;Grand&quot; &amp; Co'));
  assert.ok(businessMail().html.includes('&lt;img src=x onerror=&#39;alert(1)&#39;&gt;'));

  // The subject is plain text, so it is not escaped — but it must not be HTML either.
  assert.equal(businessMail().subject, 'New Enquiry from <script>alert("x")</script> - Wedding');

  // The record stores what the client actually typed.
  assert.equal(putItems[0].Item.client.name, '<script>alert("x")</script>');
  assert.equal(putItems[0].Item.event.venue, 'The "Grand" & Co');
});

test('line breaks in the message become <br> in the business email', async () => {
  const handler = loadHandler();
  await handler(postEvent(fullEnquiry));

  assert.ok(businessMail().html.includes('First dance is Perfect by Ed Sheeran.<br>No Mr Brightside please.'));
});

test('a bare enquiry with only the required fields still succeeds', async () => {
  const handler = loadHandler();
  const res = await handler(postEvent({ name: 'Sam', email: 'sam@example.com', phone: '028 9000 0000' }));

  assert.equal(res.statusCode, 200);

  const { Item } = putItems[0];
  assert.equal(Item.eventDate, 'unknown');
  assert.deepEqual(Item.event, { type: null, weddingPackage: null, venue: null, guestCount: null });
  assert.equal(Item.message, null);

  const business = businessMail();
  assert.equal(business.subject, 'New Enquiry from Sam - Event');
  assert.ok(business.html.includes('Not specified'));
  assert.ok(!business.html.includes('Wedding Package'));
  assert.ok(!business.html.includes('Additional Details'));
  assert.ok(clientMail().html.includes('for your event.'));
});

test('an unparseable date is stored as unknown and rendered as Not specified', async () => {
  const handler = loadHandler();
  await handler(postEvent({ ...fullEnquiry, eventDate: 'sometime next summer' }));

  assert.equal(putItems[0].Item.eventDate, 'unknown');
  assert.ok(businessMail().html.includes('Not specified'));
  assert.ok(!businessMail().html.includes('Invalid Date'));
});

test('wedding package is ignored for non-wedding events', async () => {
  const handler = loadHandler();
  await handler(postEvent({ ...fullEnquiry, eventType: 'corporate', weddingPackage: 'full-night' }));

  assert.equal(putItems[0].Item.event.type, 'corporate');
  assert.equal(putItems[0].Item.event.weddingPackage, null);
  assert.equal(businessMail().subject, 'New Enquiry from Aoife Murphy - Corporate Event');
  assert.ok(!businessMail().html.includes('Wedding Package'));
});

test('unknown event types get a readable label rather than the raw value', async () => {
  const handler = loadHandler();
  await handler(postEvent({ ...fullEnquiry, eventType: 'birthday-party' }));

  assert.equal(businessMail().subject, 'New Enquiry from Aoife Murphy - Birthday party');
});

test('when the DynamoDB write fails the emails still go out and the request succeeds', async () => {
  const handler = loadHandler();
  dynamoSend.mock.mockImplementation(async () => { throw new Error('ProvisionedThroughputExceeded'); });

  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 200);
  assert.equal(sentMail.length, 2);
  assert.ok(businessMail().html.includes('Booking reference: not recorded'));
});

test('when BOOKINGS_TABLE is unset the write is skipped and the emails still go out', async () => {
  const handler = loadHandler({ table: null });

  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 200);
  assert.equal(dynamoSend.mock.callCount(), 0);
  assert.equal(sentMail.length, 2);
});

test('when the business email fails but the record was saved, the client still gets 200', async () => {
  const handler = loadHandler();
  sendMail.mock.mockImplementation(async (options) => {
    if (options.to === 'enquiries@perfecteventsni.com') throw new Error('SES throttled');
    sentMail.push(options);
    return {};
  });

  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 200);
  assert.equal(putItems.length, 1);
  assert.equal(JSON.parse(res.body).message, 'Enquiry received. There was a minor issue, but we have it on record.');
  assert.equal(sentMail.length, 1, 'client confirmation is still attempted');
});

test('when the client email fails but everything else worked, the response is a partial success', async () => {
  const handler = loadHandler();
  sendMail.mock.mockImplementation(async (options) => {
    if (options.to !== 'enquiries@perfecteventsni.com') throw new Error('bounce');
    sentMail.push(options);
    return {};
  });

  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).message, 'Enquiry received. There was a minor issue, but we have it on record.');
});

test('only when both the write and the business email fail does the request fail', async () => {
  const handler = loadHandler();
  dynamoSend.mock.mockImplementation(async () => { throw new Error('dynamo down'); });
  sendMail.mock.mockImplementation(async (options) => {
    if (options.to === 'enquiries@perfecteventsni.com') throw new Error('ses down');
    return {};
  });

  const res = await handler(postEvent(fullEnquiry));

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, 'Failed to send enquiry');
});

test('supports the REST API v1 event shape as well as HTTP API v2', async () => {
  const handler = loadHandler();
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify(fullEnquiry) });

  assert.equal(res.statusCode, 200);
  assert.equal(putItems.length, 1);
});
