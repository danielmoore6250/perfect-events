# Booking system — plan and handover

Context for anyone (or any assistant) picking this up mid-stream. The goal is a
small booking management system for Perfect Events NI, built on the site's
existing AWS stack. Volume is a handful of events a month, not hundreds: simple
and cheap beats feature-rich.

## The problem being solved

Today an enquiry arrives as an email, the back-and-forth happens in the inbox,
invoices and files live in folders on a Mac, dates go into a phone calendar by
hand, and a details form is emailed as plain text about a month before the event.
Nothing joins those up, so the state of a booking only exists in Daniel's head.

## The approach

Every enquiry becomes one record that moves through stages. Email with clients
stays exactly as it is; the system tracks where each booking has got to.

| Stage | Meaning | Set by |
| --- | --- | --- |
| `enquiry` | Website form submitted | Automatic |
| `quoted` | Price sent to the client | Manual |
| `booked` | Deposit paid; appears in the calendar feed | Manual |
| `details-requested` | Client sent their personalised planning form link | Reminder or manual |
| `details-received` | Client submitted the planning form | Automatic |
| `completed` / `lost` | Event done and paid, or enquiry went nowhere | Manual |

## Existing stack (unchanged)

- Create React App site, deployed to S3 behind CloudFront (`perfecteventsni.com`)
- API Gateway HTTP API → `perfect-events-send-enquiry` Lambda → Amazon SES
- AWS CDK in `infra/`, account `091869720829`, region `eu-west-1`
- CloudFront serves `index.html` for unknown paths, so client-side routes such as
  `/admin` and `/plan/:token` work without hosting changes

## Phase 1 — store enquiries (code complete, not deployed)

On branch `bookings-phase-1`, two commits on top of `main`:

- `c3e421a` Store enquiries in DynamoDB and escape client input in emails
- `676bd0a` Add GitHub Actions deploy and PR check workflows

### What changed

`infra/lib/infra-stack.ts`

- DynamoDB table `perfect-events-bookings`: partition key `id`, on-demand billing,
  `RemovalPolicy.RETAIN`, point-in-time recovery on. RETAIN is deliberate —
  everything else in the stack is rebuildable from code, booking history is not.
- Global secondary index `ByEventDate`: partition key `recordType` (always the
  literal `booking`), sort key `eventDate`. Gives the admin screen a date-ordered
  list from a single-partition query instead of a table scan.
- The enquiry Lambda gets `dynamodb:PutItem` on that table and nothing else.
- New stack output `BookingsTableName`.

`aws/lambda/send-enquiry/index.js`

- Writes the booking record before sending email. If the write fails the emails
  still go out; the request only fails when both the write and the business email
  fail.
- All client-supplied values are HTML-escaped in both emails (they were
  interpolated raw before).
- Missing or malformed fields no longer throw: a missing date stores as `unknown`
  and renders as "Not specified". Previously a missing `eventType` produced a 500.
- The enquiry email shows the wedding package and a short booking reference (first
  8 characters of the record id, uppercased).
- New dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`.

### Record shape

```json
{
  "id": "uuid",
  "recordType": "booking",
  "status": "enquiry",
  "source": "website",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "eventDate": "YYYY-MM-DD | unknown",
  "client": { "name": "", "email": "", "phone": "" },
  "event": { "type": "", "weddingPackage": null, "venue": "", "guestCount": "" },
  "message": "",
  "statusHistory": [{ "status": "enquiry", "at": "ISO-8601", "by": "website-form" }]
}
```

Later phases add: `pricing` (quote, deposit, balance, paid dates), `notes`,
`planningToken`, `planningAnswers`, `files` (S3 keys).

### Verified locally

Handler run with SES and DynamoDB stubbed: correct record written, both emails
sent, `<script>` in a name escaped, line breaks preserved, bare submission with no
date or event type handled. `tsc --noEmit` and `cdk synth` both pass, and the
synthesised template shows the table, index, `BOOKINGS_TABLE` env var and the
single `PutItem` grant. React build passes with `CI=true`.

## Deployment via GitHub Actions (code complete, needs AWS setup)

Mirrors the irish-dancing-app repo: OIDC role assumption, no stored AWS keys,
manual deploys.

- `.github/workflows/deploy.yml` — `workflow_dispatch` with a branch input;
  assumes the role, `npm ci`, React build, `cdk deploy --require-approval never`.
  The stack itself syncs `build/` to S3 and invalidates CloudFront, so one job
  covers front and back end. Concurrency group prevents overlapping deploys.
- `.github/workflows/pr-checks.yml` — on PRs to `main` and pushes to `main`:
  install, Lambda handler tests, React build, infra type check, `cdk synth`. Synth
  needs no credentials.
- `DEPLOYMENT.md` — the one-time AWS setup, copy-paste ready.

### Tests

`aws/lambda/send-enquiry/test/handler.test.js`, run with `npm test` in that
directory. Uses Node's built-in test runner so nothing extra goes in the Lambda
bundle. DynamoDB is stubbed at the document client and email at the nodemailer
transport, so tests assert on the exact record written and the exact HTML sent:
validation, escaping, date handling, the write-before-email order, and every
degraded path (write fails, table unset, either email fails, both fail).

`src/admin/AdminApp.test.js` (`CI=true npm test -- --watchAll=false`) walks the
admin screen against a mocked `fetch`: sign-in, first-login password, forgot
password, list filters, detail, a save that sends only changed fields, a stale
save, a refresh that fails on the network, session expiry and sign-out. It works
because the admin screen never imports the public site: CRA's jest cannot
resolve Swiper's subpath exports (`transformIgnorePatterns` does not fix it — it
is a resolver issue, not a transform one), so nothing that imports `App.js` can
be tested this way. The CRA boilerplate test was removed for that reason.

## Outstanding

1. **Push `main`.** Local `main` is 3 commits ahead of `origin/main` (`7c648d2`),
   0 behind — a clean fast-forward.
2. **Push `bookings-phase-1`** and open a PR.
3. **AWS console — OIDC provider.** Check IAM → Identity providers for
   `token.actions.githubusercontent.com`; add it if missing (audience
   `sts.amazonaws.com`).
4. **AWS console — deploy role.** Create `perfect-events-github-deploy` with the
   trust policy and inline permissions in `DEPLOYMENT.md`. Trust is scoped to
   `repo:danielmoore6250/perfect-events:*`; permissions are only `sts:AssumeRole`
   on the CDK bootstrap roles plus reading the bootstrap version parameter.
5. **GitHub secret.** `AWS_ROLE_ARN` = the new role's ARN.
6. **Deploy and verify.** Run the Deploy workflow, submit a test enquiry on the
   live site, confirm the record appears in `perfect-events-bookings` and that both
   emails still arrive.

Alternatively `./infra/deploy.sh` deploys from a machine with AWS credentials and
skips steps 3–5, but the workflow is the intended route.

## Phase 2 — admin screen (deployed 2026-09-24)

Phase 1 was deployed and verified on 2026-09-22, Phase 2 on 2026-09-24: sign-in,
list, and a stage change with a quote all confirmed against the table.

### Auth

- Cognito user pool `perfect-events-admin`, self sign-up off, `RETAIN`. One user
  created by the stack (`CfnUserPoolUser`) with the address from the `adminEmail`
  CDK context value, default `enquiries@perfecteventsni.com`. Cognito emails a
  temporary password on first deploy; the first sign-in forces a new password
  (12+ chars, upper, lower, digit).
- App client `perfect-events-admin-web`: no secret, `USER_PASSWORD_AUTH` only, 1h
  tokens, 30-day refresh. The React screen calls Cognito's JSON API directly with
  `fetch` (`src/admin/auth.js`), so no auth SDK is in the bundle. Session lives in
  `localStorage` and refreshes itself; a refresh that fails on the network keeps
  the session and shows an error, only a rejected token signs the admin out.
- "Forgot password?" on the sign-in screen uses Cognito's `ForgotPassword` and
  `ConfirmForgotPassword`: a code is emailed to the admin address, then a new
  password is set and the screen signs in with it.
- `HttpUserPoolAuthorizer` on the bookings routes: API Gateway rejects a bad or
  missing token before the Lambda runs. The Lambda takes the actor's email from
  the JWT claims for `statusHistory`.

### API — `aws/lambda/admin-bookings`

| Route | Auth | Does |
| --- | --- | --- |
| `GET /admin/config` | none | Region, user pool id and client id for the login screen |
| `GET /admin/bookings` | JWT | Query `ByEventDate`, all pages, oldest date first |
| `GET /admin/bookings/{id}` | JWT | One record |
| `PATCH /admin/bookings/{id}` | JWT | Update `status`, `eventDate`, `pricing`, `notes` |

`PATCH` validates every field and rejects unknown ones. Dates are checked as
real calendar dates (`2027-02-30` is refused, `Date.parse` alone would accept it).
A status change appends `{status, at, by}` to `statusHistory`; sending the same
status does not. The body may carry `expectedUpdatedAt`, the `updatedAt` the
caller loaded; the update is conditional on it, so a tab that loaded the record
before someone else saved gets a 409 instead of overwriting them. The screen
always sends it. Lambda IAM is `GetItem` and `UpdateItem` on the table plus
`Query` on the index — no delete, no scan.

`pricing` is always the full shape `{ quote, deposit, depositPaidOn,
balancePaidOn }` with `null` for unset values; balance is derived in the UI.

Tests: `npm test` in the Lambda directory, 22 cases, run in PR checks.

### Screen — `src/admin/`

- `src/index.js` renders `AdminApp` (lazy-loaded) when the path starts with
  `/admin`, otherwise the public site. No router library.
- List: defaults to open stages with a date today or later, plus TBC dates.
  Filter by stage, toggle past dates. Rows link to `/admin/<id>` (pushState).
- Detail: client and event facts, the enquiry message, status history, and a
  form for stage, event date, quote, deposit, paid dates and notes. Only changed
  fields are sent. Balance due is shown from quote minus deposit.
- `robots.txt` disallows `/admin`.

## Phase 3 — calendar feed (deployed 2026-09-24)

Deployed and verified: the live feed served the test booking once it was moved
to Booked, and parsed cleanly with ical.js.

### How it works

- The feed URL is `<api>/calendar/<token>.ics`. The token is 192 random bits
  stored on a settings record in the bookings table (`id = settings:calendar`,
  `recordType = settings`, so it never appears in the `ByEventDate` index).
- `aws/lambda/calendar-feed` handles `GET /calendar/{token}`: reads the settings
  record, compares the token in constant time, and on a mismatch returns the same
  404 as a missing route. IAM is `GetItem` on the table and `Query` on the index.
- Every booking at `booked`, `details-requested`, `details-received` or
  `completed` with a real date becomes an all-day `VEVENT`: summary "Wedding:
  Aoife Murphy", venue as `LOCATION`, description with phone, email, package,
  guests, quote and balance, stage, notes, and a link to the admin page. Times
  are not on the record yet; Phase 4 adds them.
- Admin Lambda: `GET /admin/calendar` returns the token (creating it on first
  use with `if_not_exists`), `POST /admin/calendar/rotate` replaces it. Both
  behind the JWT authorizer. The screen builds the URL from `API_BASE`.
- Admin screen: "Calendar" in the header opens `/admin/calendar` with the link,
  a copy button, "Generate a new link" (with confirm) and subscribe instructions
  for iPhone, Mac and Google Calendar.
- The empty booking list now says why it is empty ("1 booking hidden because the
  date has passed") with a one-click fix.

Tests: 16 for the calendar Lambda, 25 for the admin Lambda, 13 React cases.

### To deploy and try

1. Merge the PR, run the Deploy workflow.
2. In the admin screen open Calendar, copy the link, subscribe on the phone.
3. Move a booking to Booked and confirm it appears in the calendar after the
   next refresh (calendar apps poll on their own schedule, often hourly).

## Phase 4 — client planning form (deployed 2026-09-24)

Deployed and verified: a link was created on the test booking, the form was
filled in, the booking moved to Details received, and the calendar description
picked up the timings.

### How it works

- A booking gets `planningToken` (192 random bits) the moment its stage becomes
  `booked`, via `if_not_exists` so an existing link is never replaced. The admin
  can also create or regenerate one with `POST /admin/bookings/{id}/planning-link`
  (`{ "regenerate": true }` to replace). New sparse GSI `ByPlanningToken`.
- The client link is `perfecteventsni.com/plan/<token>`, served by `src/plan/PlanApp.js`
  (lazy-loaded from `src/index.js`, no sign-in). It calls
  `aws/lambda/planning-form` on `GET`/`POST /plan/{token}`.
- `GET` returns only what the client needs: their name, the event date and type,
  package, venue, guest count, their own previous answers, and a `locked` flag.
  No phone, email, pricing, notes, history or token.
- `POST { answers }` validates every field against a fixed list (times as HH:MM,
  short text ≤200, long text ≤3000; unknown keys rejected), saves `planning =
  { answers, submittedAt, updatedAt }`, and on the first submission moves a
  `booked` or `details-requested` booking to `details-received` with a history
  entry by `client-planning-form`. The write is conditional on the token still
  matching, so a regenerated link cannot be overwritten by an old page.
- The business gets an email on every save (received vs updated) listing the
  answers and linking to the booking. A failed email never fails the save.
- The form locks when the event is 3 days away or closer (423 on save; the page
  shows it read-only). No date means no lock.
- Fields: set-up access, guest arrival, meal, speeches (wedding), DJ start, finish;
  first dance and parent dances (wedding), last song, must play, do not play,
  music style, announcements; venue contact name and phone, access notes; anything
  else. Defined once in `src/shared/format.js` for the UI and once in the Lambda
  for validation.
- Admin detail view gains a "Planning form" card: the link with copy and "New
  link", or a "Create planning link" button, then the client's answers once they
  exist. The calendar feed adds the timings, first dance and venue contact to each
  event's description. Events stay all-day, which reads best in a day view.
- `robots.txt` disallows `/plan`.

Tests: 17 planning Lambda, 29 admin Lambda, 17 calendar Lambda, 9 React cases for
the planning page (`src/plan/PlanApp.test.js`) and 15 for the admin screen.

### To deploy and try

1. Merge the PR, run the Deploy workflow. The table gains a second index; CloudFormation
   builds it in the background and the deploy waits for it.
2. Open the test booking (already Booked). The Planning form card shows "Create
   planning link" because it was booked before this deploy; press it.
3. Copy the link, open it in a private window, fill in a few fields, send.
4. Check: the booking is at Details received, the answers show in the admin
   card, an email arrived, and the calendar event's description has the timings.

## Phase 4b — song picker (code complete, not deployed)

Branch `song-picker`. Prompted by apps like Vibo: clients pick real songs with
artwork and previews instead of typing names.

### Catalogue

- `aws/lambda/music-search` on public `GET /music/search?q=` and
  `GET /music/playlist?url=`. Apple Music is the catalogue when a MusicKit key is
  in Parameter Store (`/perfect-events/apple-music/{private-key,key-id,team-id}`,
  SecureString; setup in `DEPLOYMENT.md`). The Lambda signs the ES256 developer
  token itself with Node's crypto, no library. Deezer, which needs no key, is the
  automatic fallback, so search works before the key exists and if it ever breaks.
  Results are normalised to one shape: `{ source, id, title, artist, album,
  artwork, previewUrl, durationMs, url }`. Cached per query for 10 minutes.
- Spotify's API was ruled out: since February 2026 development-mode apps are
  capped at 5 named users and 10 search results, and extended access needs a
  business with 250k monthly users. Spotify playlist links get a clear message.
- Apple Music and Deezer playlist links import every track (up to 300).

### Data

Song fields on the planning answers (`firstDance`, `parentDances`, `lastSong`,
`mustPlay`, new `playIfPossible`, `doNotPlay`) hold a list of song records with
only the known keys, validated in the planning Lambda (source apple/deezer/manual,
https links only, list maximums 1/5/1/100/100/100). Plain text is still accepted
for these fields because forms filled in before the picker saved text; the page
shows it as a textarea with a "Use song search instead" switch.

### Screens

- `src/plan/SongPicker.js`: search with 300ms debounce, results with artwork and
  a 30-second preview (one shared player, `src/plan/preview.js`), add/remove,
  "Can't find it? Type it in" for manual entries, playlist import on Must play.
- Admin planning card shows song lists with artwork and an "Open" link, plus
  "Copy song lists as text" (Artist – Title per line) for Rekordbox/Serato prep.
- The notification email and the calendar description render songs as
  "Artist – Title".

### Abuse limits

The music routes are public, so three layers bound what a flood can cost: per-route
throttling on the API stage (search 10/s burst 20, playlist import 1/s burst 3,
with the enquiry and planning routes throttled too), reserved concurrency of 5 on
the music Lambda, and a per-address counter inside it (60 searches and 10 imports
per minute per container, 429 beyond that). Sized for a handful of clients
planning at once, not for a public product.

Tests: 14 music-search Lambda, 21 planning Lambda, 17 calendar, 16 React cases
for the planning page and picker, 16 for the admin screen.

## Phase 5 — reminders and files

- EventBridge daily rule → Lambda: find `booked` events ~30 days out, email the
  planning link (start by emailing Daniel, switch to auto-send once trusted).
- Private S3 bucket for contracts and invoices, uploaded from the admin screen via
  presigned URLs, keyed by booking id.
- Invoice generation is explicitly out of scope for now — keep invoicing as it is
  and just record the amounts.

## Conventions worth keeping

- Least privilege on every new Lambda: name the actions and the resource ARN
  rather than reaching for `grant*Data` helpers that include deletes.
- Client input is untrusted everywhere it is rendered, email included.
- Losing an enquiry is the worst outcome: prefer recording it and degrading the
  rest.
