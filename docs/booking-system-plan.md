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

There are no React tests. The CRA boilerplate test was removed: it no longer
matched the site, and CRA's jest cannot resolve Swiper's subpath exports
(`transformIgnorePatterns` does not fix it — it is a resolver issue, not a
transform one).

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

## Phase 2 — admin screen

- Cognito user pool with a single user; JWT authorizer on new API routes.
- New Lambda(s) behind `/admin/*`: list bookings (query the `ByEventDate` index),
  get one, update status, pricing and notes. Append to `statusHistory` on every
  status change.
- React route `/admin`: list by upcoming date and stage, detail view with editable
  fields. Keep it plain — this is a working screen, not a product.

## Phase 3 — calendar feed

- Lambda serving an `.ics` feed of `booked` events at a long, unguessable URL,
  subscribed once on the phone. Read-only, so nothing to keep in sync by hand.
- Include venue, times and the client's contact details in each event.

## Phase 4 — client planning form

- On `booked`, generate `planningToken` (cryptographically random, ≥128 bits).
- Public routes `GET /plan/{token}` and `POST /plan/{token}`: the GET returns only
  that booking's non-sensitive fields to prefill the page, the POST saves answers
  and emails a notification. Allow saving and returning; consider locking edits a
  few days before the event.
- React route `/plan/:token` replacing the plain-text email form: timings, first
  dance, must-play, do-not-play, venue contact, equipment access notes.
- Answers appear in the admin detail view.

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
