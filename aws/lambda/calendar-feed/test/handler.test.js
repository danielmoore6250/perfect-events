// Tests for the calendar feed. DynamoDB is stubbed at the document client.

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const HANDLER_PATH = path.join(__dirname, '..', 'index.js');
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

const loadModule = ({ table = 'bookings-test' } = {}) => {
  delete require.cache[HANDLER_PATH];
  if (table == null) delete process.env.BOOKINGS_TABLE;
  else process.env.BOOKINGS_TABLE = table;
  return require(HANDLER_PATH);
};

const request = (token, method = 'GET') => ({
  requestContext: { http: { method } },
  pathParameters: token === undefined ? undefined : { token }
});

const booking = (overrides = {}) => ({
  id: 'f32b20a2-1dc2-472c-a9b1-6b45ea9c5795',
  recordType: 'booking',
  status: 'booked',
  eventDate: '2027-06-12',
  createdAt: '2026-09-22T18:57:42.562Z',
  updatedAt: '2026-09-24T13:26:16.086Z',
  client: { name: 'Aoife Murphy', email: 'aoife@example.com', phone: '07700 900123' },
  event: { type: 'wedding', weddingPackage: 'full-night', venue: 'Galgorm Resort, Ballymena', guestCount: '150' },
  pricing: { quote: 1250, deposit: 250, depositPaidOn: '2026-10-01', balancePaidOn: null },
  notes: 'Ceremony at 2pm; band until 11.',
  ...overrides
});

let bookings;
let settingsToken;
let commands;

beforeEach(() => {
  bookings = [booking()];
  settingsToken = TOKEN;
  commands = [];
  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    commands.push(command);
    if (command instanceof GetCommand) {
      assert.equal(command.input.Key.id, 'settings:calendar');
      return { Item: settingsToken ? { id: 'settings:calendar', calendarToken: settingsToken } : undefined };
    }
    if (command instanceof QueryCommand) {
      return { Items: bookings };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });
  mock.method(console, 'error', () => {});
});

afterEach(() => mock.restoreAll());

const unfold = (body) => body.replace(/\r\n[ \t]/g, '');

test('serves the feed with the right headers when the token matches', async () => {
  const { handler } = loadModule();
  const res = await handler(request(`${TOKEN}.ics`));

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/calendar; charset=utf-8');
  assert.match(res.headers['Content-Disposition'], /\.ics/);
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(res.body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(res.body.includes('X-WR-CALNAME:Perfect Events NI bookings'));
});

test('the token works with or without the .ics suffix', async () => {
  const { handler } = loadModule();
  assert.equal((await handler(request(TOKEN))).statusCode, 200);
  assert.equal((await handler(request(`${TOKEN}.ICS`))).statusCode, 200);
});

test('a wrong, missing, or differently-cased token is a plain 404 and never queries bookings', async () => {
  const { handler } = loadModule();
  for (const token of ['nope', `${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase(), '', undefined]) {
    commands = [];
    const res = await handler(request(token));
    assert.equal(res.statusCode, 404, `token ${JSON.stringify(token)}`);
    assert.equal(res.body, 'Not found');
    assert.equal(commands.filter((c) => c instanceof QueryCommand).length, 0);
  }
});

test('when no token has been generated yet everything is a 404', async () => {
  const { handler } = loadModule();
  settingsToken = null;
  assert.equal((await handler(request(TOKEN))).statusCode, 404);
});

test('non-GET methods and a missing table are 404', async () => {
  let { handler } = loadModule();
  assert.equal((await handler(request(TOKEN, 'POST'))).statusCode, 404);
  ({ handler } = loadModule({ table: null }));
  assert.equal((await handler(request(TOKEN))).statusCode, 404);
});

test('a booked event becomes an all-day VEVENT with the client details', async () => {
  const { handler } = loadModule();
  const body = unfold((await handler(request(TOKEN))).body);

  assert.ok(body.includes('BEGIN:VEVENT'));
  assert.ok(body.includes('UID:f32b20a2-1dc2-472c-a9b1-6b45ea9c5795@perfecteventsni.com'));
  assert.ok(body.includes('DTSTART;VALUE=DATE:20270612'));
  assert.ok(body.includes('DTEND;VALUE=DATE:20270613'));
  assert.ok(body.includes('DTSTAMP:20260924T132616Z'));
  assert.ok(body.includes('SUMMARY:Wedding: Aoife Murphy'));
  assert.ok(body.includes('LOCATION:Galgorm Resort\\, Ballymena'), 'commas in the venue are escaped');
  assert.ok(body.includes('URL:https://perfecteventsni.com/admin/f32b20a2-1dc2-472c-a9b1-6b45ea9c5795'));
  assert.ok(body.includes('STATUS:CONFIRMED'));

  const description = body.match(/DESCRIPTION:(.*)/)[1];
  assert.ok(description.includes('Client: Aoife Murphy\\nPhone: 07700 900123\\nEmail: aoife@example.com'));
  assert.ok(description.includes('Package: Full night'));
  assert.ok(description.includes('Guests: 150'));
  assert.ok(description.includes('Quote: £1250.00 (balance £1000.00 due)'));
  assert.ok(description.includes('Stage: booked'));
  // One literal backslash before the semicolon (doubled here because this is JS source).
  assert.ok(description.includes('Ceremony at 2pm\\; band until 11.'), 'semicolons in notes are escaped');
  assert.ok(!description.includes('2pm; band'), 'an unescaped semicolon must not appear');
});

test('backslashes, commas and newlines in text are escaped per RFC 5545', async () => {
  const { handler } = loadModule();
  bookings = [booking({ notes: 'Path C:\\temp, then; done\nSecond line', event: { type: 'private', venue: 'The Barn; Comber' } })];
  const raw = (await handler(request(TOKEN))).body;
  const body = unfold(raw);

  const description = body.match(/DESCRIPTION:(.*)/)[1];
  assert.ok(description.includes('Path C:\\\\temp\\, then\\; done\\nSecond line'));
  assert.ok(body.includes('LOCATION:The Barn\\; Comber'));
  assert.ok(!raw.includes('Barn; Comber'), 'a bare semicolon must never appear in text');
});

test('bookings with an impossible calendar date are left out rather than emitted as a bad DTSTART', async () => {
  const { handler } = loadModule();
  bookings = [
    booking({ id: 'feb30', eventDate: '2027-02-30' }),
    booking({ id: 'apr31', eventDate: '2027-04-31' }),
    booking({ id: 'leap', eventDate: '2028-02-29' }),
    booking({ id: 'notleap', eventDate: '2027-02-29' })
  ];
  const body = unfold((await handler(request(TOKEN))).body);
  const uids = [...body.matchAll(/UID:(\w+)@/g)].map((m) => m[1]);
  assert.deepEqual(uids, ['leap']);
});

test('planning form timings and contacts appear in the description once the client has filled them in', async () => {
  const { handler } = loadModule();
  bookings = [booking({
    planning: {
      answers: { guestArrivalTime: '18:00', djStartTime: '19:30', finishTime: '00:00', firstDance: 'Perfect - Ed Sheeran', venueContactName: 'Sam', venueContactPhone: '028 9000 0000' },
      submittedAt: '2027-05-01T10:00:00.000Z',
      updatedAt: '2027-05-01T10:00:00.000Z'
    }
  })];
  const body = unfold((await handler(request(TOKEN))).body);
  const description = body.match(/DESCRIPTION:(.*)/)[1];
  assert.ok(description.includes('Timings: Guests 18:00\\, DJ 19:30\\, Finish 00:00'));
  assert.ok(description.includes('First dance: Perfect - Ed Sheeran'));
  assert.ok(description.includes('Venue contact: Sam 028 9000 0000'));

  bookings = [booking()];
  const plain = unfold((await handler(request(TOKEN))).body);
  assert.ok(!plain.includes('Timings:'));

  bookings = [booking({ planning: { answers: { firstDance: [{ source: 'apple', id: '1', title: 'Perfect', artist: 'Ed Sheeran' }] }, submittedAt: 'x', updatedAt: 'x' } })];
  const picked = unfold((await handler(request(TOKEN))).body);
  assert.ok(picked.includes('First dance: Ed Sheeran – Perfect'));
});

test('a paid balance is reported as paid', async () => {
  const { handler } = loadModule();
  bookings = [booking({ pricing: { quote: 800, deposit: 200, depositPaidOn: '2026-10-01', balancePaidOn: '2027-06-01' } })];
  const body = unfold((await handler(request(TOKEN))).body);
  assert.ok(body.includes('Quote: £800.00 (balance paid)'));
});

test('month and year boundaries roll over correctly for DTEND', async () => {
  const { handler } = loadModule();
  bookings = [booking({ id: 'a', eventDate: '2027-12-31' }), booking({ id: 'b', eventDate: '2028-02-29' })];
  const body = unfold((await handler(request(TOKEN))).body);
  assert.ok(body.includes('DTSTART;VALUE=DATE:20271231\r\nDTEND;VALUE=DATE:20280101'));
  assert.ok(body.includes('DTSTART;VALUE=DATE:20280229\r\nDTEND;VALUE=DATE:20280301'));
});

test('only booked-or-later stages with a real date appear', async () => {
  const { handler } = loadModule();
  bookings = [
    booking({ id: 'enq', status: 'enquiry' }),
    booking({ id: 'quo', status: 'quoted' }),
    booking({ id: 'bkd', status: 'booked' }),
    booking({ id: 'req', status: 'details-requested' }),
    booking({ id: 'rec', status: 'details-received' }),
    booking({ id: 'cmp', status: 'completed' }),
    booking({ id: 'lost', status: 'lost' }),
    booking({ id: 'tbc', status: 'booked', eventDate: 'unknown' })
  ];
  const body = unfold((await handler(request(TOKEN))).body);
  const uids = [...body.matchAll(/UID:(\w+)@/g)].map((m) => m[1]);
  assert.deepEqual(uids, ['bkd', 'req', 'rec', 'cmp']);
});

test('an empty calendar is still a valid calendar', async () => {
  const { handler } = loadModule();
  bookings = [];
  const res = await handler(request(TOKEN));
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('VEVENT'));
  assert.ok(res.body.includes('END:VCALENDAR'));
});

test('missing optional fields do not break the event', async () => {
  const { handler } = loadModule();
  bookings = [booking({ client: { name: '', email: '', phone: '' }, event: { type: 'corporate' }, pricing: undefined, notes: null })];
  const body = unfold((await handler(request(TOKEN))).body);
  assert.ok(body.includes('SUMMARY:Corporate event: Unknown client'));
  assert.ok(!body.includes('LOCATION:'));
  assert.ok(!body.includes('Quote:'));
  assert.ok(!body.includes('Package:'));
});

test('long lines are folded at 75 octets without splitting multi-byte characters', async () => {
  const { foldLine } = loadModule();
  const long = 'DESCRIPTION:' + 'é'.repeat(100);
  const folded = foldLine(long);

  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${Buffer.byteLength(line, 'utf8')}`);
  }
  assert.equal(folded.replace(/\r\n /g, ''), long, 'unfolding restores the original');
  assert.ok(!folded.includes('�'));
});

test('pagination is followed when listing bookings', async () => {
  const { handler } = loadModule();
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    if (command instanceof GetCommand) return { Item: { calendarToken: TOKEN } };
    call += 1;
    if (call === 1) return { Items: [booking({ id: 'one' })], LastEvaluatedKey: { id: 'one' } };
    assert.deepEqual(command.input.ExclusiveStartKey, { id: 'one' });
    return { Items: [booking({ id: 'two' })] };
  });
  const body = unfold((await handler(request(TOKEN))).body);
  assert.ok(body.includes('UID:one@') && body.includes('UID:two@'));
});

test('a DynamoDB failure is a 500, not a stack trace', async () => {
  const { handler } = loadModule();
  mock.method(DynamoDBDocumentClient.prototype, 'send', async () => { throw new Error('boom'); });
  const res = await handler(request(TOKEN));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, 'Something went wrong');
});
