// The admin screen: sign in, list bookings, open one, edit its stage, date,
// pricing and notes. A working screen, kept deliberately plain.

import { useState, useEffect, useCallback } from 'react';
import '../styles/Admin.css';
import { getSession, signIn, completeNewPassword, forgotPassword, confirmForgotPassword, clearSession } from './auth';
import { listBookings, getBooking, updateBooking, getCalendarLink, rotateCalendarLink, calendarFeedUrl, createPlanningLink, planningFormUrl } from './api';
import { EVENT_TYPE_LABELS, WEDDING_PACKAGE_LABELS, labelFor, formatEventDate, formatDateTime, PLANNING_SECTIONS, PLANNING_FIELD_LABELS, answersToSetlistText } from '../shared/format';

const STATUSES = [
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'quoted', label: 'Quoted' },
  { value: 'booked', label: 'Booked' },
  { value: 'details-requested', label: 'Details requested' },
  { value: 'details-received', label: 'Details received' },
  { value: 'completed', label: 'Completed' },
  { value: 'lost', label: 'Lost' }
];
const CLOSED_STATUSES = new Set(['completed', 'lost']);
const statusLabel = (value) => STATUSES.find((s) => s.value === value)?.label || value || 'Unknown';

// Today in the admin's own timezone: toISOString() would give UTC, which is
// yesterday for an hour every night during British Summer Time.
const todayIso = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};


const formatMoney = (amount) =>
  typeof amount === 'number' ? `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

const reference = (id) => (id || '').slice(0, 8).toUpperCase();

// ---- Tiny router: /admin, /admin/calendar and /admin/<booking id> ----------

const CALENDAR_ROUTE = 'calendar';

const routeFromPath = () => {
  const match = window.location.pathname.match(/^\/admin\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const useAdminRoute = () => {
  const [route, setRoute] = useState(routeFromPath);

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next) => {
    const path = next ? `/admin/${encodeURIComponent(next)}` : '/admin';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(next || null);
    window.scrollTo(0, 0);
  }, []);

  return [route, navigate];
};

// ---- Screens ---------------------------------------------------------------

function Login({ onSignedIn }) {
  // 'signin' | 'new-password' (first login) | 'forgot' (request code) | 'reset' (enter code)
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [cognitoSession, setCognitoSession] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setInfo('');
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setCode('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const address = email.trim();
    try {
      if (mode === 'new-password' || mode === 'reset') {
        if (newPassword !== confirmPassword) throw new Error('The new passwords do not match.');
      }

      if (mode === 'new-password') {
        onSignedIn(await completeNewPassword(address, newPassword, cognitoSession));
      } else if (mode === 'forgot') {
        await forgotPassword(address);
        switchMode('reset');
        setInfo(`If ${address} is the admin address, a reset code is on its way.`);
      } else if (mode === 'reset') {
        await confirmForgotPassword(address, code, newPassword);
        const result = await signIn(address, newPassword);
        onSignedIn(result.session);
      } else {
        const result = await signIn(address, password);
        if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
          setCognitoSession(result.cognitoSession);
          switchMode('new-password');
        } else {
          onSignedIn(result.session);
        }
      }
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const titles = {
    signin: 'Admin sign in',
    'new-password': 'Choose a password',
    forgot: 'Reset your password',
    reset: 'Enter the reset code'
  };
  const actions = {
    signin: 'Sign in',
    'new-password': 'Set password and sign in',
    forgot: 'Email me a reset code',
    reset: 'Set password and sign in'
  };

  const passwordFields = (
    <>
      <label className="field">
        <span>New password</span>
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required autoFocus={mode === 'new-password'} />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
      </label>
    </>
  );

  return (
    <div className="admin admin--centered">
      <form className="login" onSubmit={submit}>
        <p className="admin__eyebrow">Perfect Events NI</p>
        <h1 className="login__title">{titles[mode]}</h1>

        {mode === 'new-password' && (
          <p className="login__hint">
            First sign-in. Pick a new password: at least 12 characters with upper and lower case letters and a number.
          </p>
        )}
        {mode === 'forgot' && (
          <p className="login__hint">Enter the admin email address and Cognito will email you a code to set a new password.</p>
        )}
        {info && <p className="notice notice--ok">{info}</p>}

        {mode !== 'new-password' && (
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus readOnly={mode === 'reset'} />
          </label>
        )}

        {mode === 'signin' && (
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
        )}

        {mode === 'reset' && (
          <label className="field">
            <span>Reset code</span>
            <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required autoFocus />
          </label>
        )}

        {(mode === 'new-password' || mode === 'reset') && passwordFields}

        {error && <p className="notice notice--error" role="alert">{error}</p>}

        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Please wait…' : actions[mode]}
        </button>

        {mode === 'signin' && (
          <button type="button" className="button button--link" onClick={() => switchMode('forgot')}>Forgot password?</button>
        )}
        {(mode === 'forgot' || mode === 'reset') && (
          <button type="button" className="button button--link" onClick={() => switchMode('signin')}>Back to sign in</button>
        )}
      </form>
    </div>
  );
}

function BookingList({ onOpen, onAuthLost }) {
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('active');
  const [includePast, setIncludePast] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setBookings(await listBookings());
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.message);
    }
  }, [onAuthLost]);

  useEffect(() => {
    load();
  }, [load]);

  const today = todayIso();
  const matchesStage = (b) => (stage === 'active' ? !CLOSED_STATUSES.has(b.status) : stage === 'all' || b.status === stage);
  const isPast = (b) => b.eventDate !== 'unknown' && b.eventDate < today;

  const visible = (bookings || [])
    .filter((b) => matchesStage(b) && (includePast || !isPast(b)))
    // 'unknown' sorts after any YYYY-MM-DD, which is where a TBC date belongs.
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : 0));

  // So an empty list can say why, rather than just "nothing matches".
  const hiddenPast = includePast ? 0 : (bookings || []).filter((b) => matchesStage(b) && isPast(b)).length;
  const hiddenByStage = (bookings || []).filter((b) => !matchesStage(b)).length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <section>
      <div className="toolbar">
        <div className="toolbar__filters">
          <label className="field field--inline">
            <span>Stage</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="active">All open</option>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
              <option value="all">Everything</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
            <span>Include past dates</span>
          </label>
        </div>
        <button type="button" className="button" onClick={load}>Refresh</button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {bookings === null ? (
        <p className="muted">Loading bookings…</p>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>{bookings.length === 0 ? 'No bookings yet. New enquiries from the website will appear here.' : 'No bookings match.'}</p>
          {hiddenPast > 0 && (
            <p className="muted">
              {plural(hiddenPast, 'booking')} hidden because the date has passed.{' '}
              <button type="button" className="button button--link" onClick={() => setIncludePast(true)}>Show past dates</button>
            </p>
          )}
          {hiddenByStage > 0 && (
            <p className="muted">
              {plural(hiddenByStage, 'booking')} in other stages.{' '}
              <button type="button" className="button button--link" onClick={() => setStage('all')}>Show every stage</button>
            </p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="bookings">
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Event</th>
                <th>Venue</th>
                <th>Stage</th>
                <th className="num">Quote</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr key={b.id} onClick={() => onOpen(b.id)}>
                  <td className={b.eventDate === 'unknown' ? 'muted' : ''}>{formatEventDate(b.eventDate)}</td>
                  <td>
                    <a
                      className="row-link"
                      href={`/admin/${encodeURIComponent(b.id)}`}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(b.id); }}
                    >
                      {b.client?.name || 'Unknown'}
                    </a>
                    <div className="muted small">{reference(b.id)}</div>
                  </td>
                  <td>
                    {labelFor(EVENT_TYPE_LABELS, b.event?.type, 'Event')}
                    {b.event?.type === 'wedding' && b.event?.weddingPackage && (
                      <div className="muted small">{labelFor(WEDDING_PACKAGE_LABELS, b.event.weddingPackage)}</div>
                    )}
                  </td>
                  <td>{b.event?.venue || <span className="muted">—</span>}</td>
                  <td><span className={`badge badge--${b.status}`}>{statusLabel(b.status)}</span></td>
                  <td className="num">{formatMoney(b.pricing?.quote)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bookings !== null && (
        <p className="muted small">
          Showing {visible.length} of {bookings.length} booking{bookings.length === 1 ? '' : 's'}.
        </p>
      )}
    </section>
  );
}

const formFromBooking = (b) => ({
  status: b.status || 'enquiry',
  eventDate: b.eventDate === 'unknown' ? '' : b.eventDate || '',
  quote: b.pricing?.quote ?? '',
  deposit: b.pricing?.deposit ?? '',
  depositPaidOn: b.pricing?.depositPaidOn || '',
  balancePaidOn: b.pricing?.balancePaidOn || '',
  notes: b.notes || ''
});

// Only what actually changed goes to the API, so a save never overwrites a
// field the admin did not touch.
const changesBetween = (original, form) => {
  const changes = {};
  if (form.status !== original.status) changes.status = form.status;
  if (form.eventDate !== original.eventDate) changes.eventDate = form.eventDate || 'unknown';
  if (form.notes !== original.notes) changes.notes = form.notes;

  const pricingKeys = ['quote', 'deposit', 'depositPaidOn', 'balancePaidOn'];
  if (pricingKeys.some((k) => String(form[k]) !== String(original[k]))) {
    changes.pricing = Object.fromEntries(pricingKeys.map((k) => [k, form[k] === '' ? null : form[k]]));
  }
  return changes;
};

// The client's planning link and, once they have filled it in, their answers.
// A song list on the admin side: artwork, title, artist, link. Legacy text
// from before the picker shows as it was typed.
function SongAnswer({ value }) {
  if (typeof value === 'string') return <dd className="prewrap">{value}</dd>;
  return (
    <dd>
      <ul className="songlist songlist--admin">
        {value.map((song, i) => (
          <li className="song" key={`${song.source}:${song.id || song.title}:${i}`}>
            {song.artwork ? <img className="song__art" src={song.artwork} alt="" loading="lazy" /> : <span className="song__art song__art--blank" aria-hidden="true">♪</span>}
            <span className="song__text">
              <span className="song__title">{song.title}</span>
              <span className="song__artist muted small">{song.artist || (song.source === 'manual' ? 'Typed in by the client' : '')}</span>
            </span>
            {song.url && <a className="button button--small" href={song.url} target="_blank" rel="noreferrer">Open</a>}
          </li>
        ))}
      </ul>
    </dd>
  );
}

function PlanningCard({ booking, onBookingChange, onAuthLost }) {
  const [copied, setCopied] = useState(false);
  const [copiedSetlist, setCopiedSetlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const url = booking.planningToken ? planningFormUrl(booking.planningToken) : null;
  const answers = booking.planning?.answers || {};
  const answered = PLANNING_SECTIONS.flatMap((s) => s.fields).filter((f) => answers[f.key] && (!Array.isArray(answers[f.key]) || answers[f.key].length));
  const isWedding = booking.event?.type === 'wedding';
  const setlist = answersToSetlistText(answers);

  const copySetlist = async () => {
    try {
      await navigator.clipboard.writeText(setlist);
      setCopiedSetlist(true);
      setTimeout(() => setCopiedSetlist(false), 2000);
    } catch {
      setError('Could not copy. Select the text and copy it by hand.');
    }
  };

  const run = async (fn) => {
    setError('');
    setBusy(true);
    try {
      onBookingChange(await fn());
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  };

  const regenerate = () => {
    if (!window.confirm('Create a new planning link? The one the client already has will stop working.')) return;
    run(() => createPlanningLink(booking.id, { regenerate: true }));
  };

  return (
    <div className="card">
      <h2 className="card__title">Planning form</h2>

      {url ? (
        <>
          <p className="calendar__url"><code>{url}</code></p>
          <div className="detail__actions">
            <button type="button" className="button" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" className="button button--link" onClick={regenerate} disabled={busy}>New link</button>
          </div>
          <p className="muted small">Send this to the client. They fill in timings, music and venue details and can come back to edit until three days before the event.</p>
        </>
      ) : (
        <>
          <p className="muted small">No link yet. One is created automatically when the booking moves to Booked, or make one now.</p>
          <button type="button" className="button" onClick={() => run(() => createPlanningLink(booking.id))} disabled={busy}>
            {busy ? 'Working…' : 'Create planning link'}
          </button>
        </>
      )}

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {booking.planning?.submittedAt ? (
        <div className="planning">
          <p className="muted small">
            Filled in {formatDateTime(booking.planning.submittedAt)}
            {booking.planning.updatedAt !== booking.planning.submittedAt && `, last changed ${formatDateTime(booking.planning.updatedAt)}`}
          </p>
          {answered.length === 0 ? (
            <p className="muted">They saved the form without any answers.</p>
          ) : (
            <>
              {setlist && (
                <div className="detail__actions planning__tools">
                  <button type="button" className="button button--small" onClick={copySetlist}>{copiedSetlist ? 'Copied' : 'Copy song lists as text'}</button>
                  <span className="muted small">Artist – Title per line, for Rekordbox or Serato prep.</span>
                </div>
              )}
              <dl className="facts facts--stacked">
                {answered
                  .filter((f) => !f.weddingOnly || isWedding)
                  .map((f) => (
                    <div key={f.key} className="planning__item">
                      <dt>{PLANNING_FIELD_LABELS[f.key]}</dt>
                      {f.type === 'songs' ? <SongAnswer value={answers[f.key]} /> : <dd className="prewrap">{answers[f.key]}</dd>}
                    </div>
                  ))}
              </dl>
            </>
          )}
        </div>
      ) : (
        url && <p className="muted small">Not filled in yet.</p>
      )}
    </div>
  );
}

function BookingDetail({ id, onBack, onAuthLost }) {
  const [booking, setBooking] = useState(null);
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((b) => {
    setBooking(b);
    const f = formFromBooking(b);
    setForm(f);
    setOriginal(f);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      apply(await getBooking(id));
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.message);
    }
  }, [id, apply, onAuthLost]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (e) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const changes = form && original ? changesBetween(original, form) : {};
  const dirty = Object.keys(changes).length > 0;

  const save = async (e) => {
    e.preventDefault();
    if (!dirty) return;
    setError('');
    setBusy(true);
    try {
      apply(await updateBooking(id, { ...changes, expectedUpdatedAt: booking.updatedAt }));
      setSaved(true);
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.status === 409 ? `${err.message}` : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !booking) {
    return (
      <section>
        <button type="button" className="button button--link" onClick={onBack}>← All bookings</button>
        <p className="notice notice--error" role="alert">{error}</p>
      </section>
    );
  }
  if (!booking || !form) {
    return <p className="muted">Loading booking…</p>;
  }

  const quote = Number(form.quote);
  const deposit = Number(form.deposit);
  const balance = form.quote !== '' && Number.isFinite(quote) ? quote - (Number.isFinite(deposit) ? deposit : 0) : null;
  const { client = {}, event = {} } = booking;

  return (
    <section>
      <button type="button" className="button button--link" onClick={onBack}>← All bookings</button>

      <div className="detail__head">
        <div>
          <p className="admin__eyebrow">{reference(booking.id)} · {labelFor(EVENT_TYPE_LABELS, event.type, 'Event')}</p>
          <h1 className="detail__title">{client.name || 'Unknown client'}</h1>
          <p className="detail__date">{formatEventDate(booking.eventDate, { long: true })}{event.venue ? ` · ${event.venue}` : ''}</p>
        </div>
        <span className={`badge badge--lg badge--${booking.status}`}>{statusLabel(booking.status)}</span>
      </div>

      <div className="detail__grid">
        <div className="detail__info">
          <div className="card">
            <h2 className="card__title">Client</h2>
            <dl className="facts">
              <dt>Email</dt><dd>{client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : '—'}</dd>
              <dt>Phone</dt><dd>{client.phone ? <a href={`tel:${client.phone}`}>{client.phone}</a> : '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <h2 className="card__title">Event</h2>
            <dl className="facts">
              <dt>Type</dt><dd>{labelFor(EVENT_TYPE_LABELS, event.type)}</dd>
              {event.type === 'wedding' && (<><dt>Package</dt><dd>{labelFor(WEDDING_PACKAGE_LABELS, event.weddingPackage)}</dd></>)}
              <dt>Venue</dt><dd>{event.venue || '—'}</dd>
              <dt>Guests</dt><dd>{event.guestCount || '—'}</dd>
              <dt>Source</dt><dd>{booking.source || '—'}</dd>
            </dl>
          </div>

          {booking.message && (
            <div className="card">
              <h2 className="card__title">Message from the enquiry</h2>
              <p className="prewrap">{booking.message}</p>
            </div>
          )}

          <PlanningCard booking={booking} onBookingChange={apply} onAuthLost={onAuthLost} />

          <div className="card">
            <h2 className="card__title">History</h2>
            <ol className="history">
              {(booking.statusHistory || []).map((entry, i) => (
                <li key={`${entry.at}-${i}`}>
                  <span className={`badge badge--${entry.status}`}>{statusLabel(entry.status)}</span>
                  <span className="muted small">{formatDateTime(entry.at)} · {entry.by}</span>
                </li>
              ))}
            </ol>
            <p className="muted small">Received {formatDateTime(booking.createdAt)} · last updated {formatDateTime(booking.updatedAt)}</p>
          </div>
        </div>

        <form className="card detail__form" onSubmit={save}>
          <h2 className="card__title">Update</h2>

          <label className="field">
            <span>Stage</span>
            <select value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Event date</span>
            <input type="date" value={form.eventDate} onChange={set('eventDate')} />
            <small className="muted">Leave empty if the date is still to be confirmed.</small>
          </label>

          <div className="field-row">
            <label className="field">
              <span>Quote (£)</span>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={form.quote} onChange={set('quote')} />
            </label>
            <label className="field">
              <span>Deposit (£)</span>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={form.deposit} onChange={set('deposit')} />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Deposit paid on</span>
              <input type="date" value={form.depositPaidOn} onChange={set('depositPaidOn')} />
            </label>
            <label className="field">
              <span>Balance paid on</span>
              <input type="date" value={form.balancePaidOn} onChange={set('balancePaidOn')} />
            </label>
          </div>

          <p className="balance">
            Balance due: <strong>{balance === null ? '—' : formatMoney(Math.max(balance, 0))}</strong>
            {form.balancePaidOn && balance !== null && <span className="muted"> · paid</span>}
          </p>

          <label className="field">
            <span>Notes</span>
            <textarea rows={7} value={form.notes} onChange={set('notes')} placeholder="Anything worth remembering about this booking" />
          </label>

          {error && <p className="notice notice--error" role="alert">{error}</p>}
          {saved && !dirty && <p className="notice notice--ok">Saved.</p>}

          <div className="detail__actions">
            <button type="submit" className="button button--primary" disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            {dirty && !busy && (
              <button type="button" className="button button--link" onClick={() => { setForm(original); setError(''); }}>Discard</button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function CalendarPage({ onBack, onAuthLost }) {
  const [calendar, setCalendar] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setCalendar(await getCalendarLink());
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.message);
    }
  }, [onAuthLost]);

  useEffect(() => {
    load();
  }, [load]);

  const url = calendar ? calendarFeedUrl(calendar.token) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  };

  const rotate = async () => {
    if (!window.confirm('Generate a new link? The current one will stop working and every subscribed calendar will need the new link.')) return;
    setError('');
    setBusy(true);
    try {
      setCalendar(await rotateCalendarLink());
    } catch (err) {
      if (err.status === 401) return onAuthLost();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <button type="button" className="button button--link" onClick={onBack}>← All bookings</button>

      <div className="detail__head">
        <div>
          <p className="admin__eyebrow">Calendar feed</p>
          <h1 className="detail__title">Bookings in your calendar</h1>
          <p className="detail__date">Subscribe once. Every booking at the Booked stage or later appears automatically, with the venue and the client's contact details.</p>
        </div>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <div className="stack">
      <div className="card">
        <h2 className="card__title">Your private link</h2>
        {calendar ? (
          <>
            <p className="calendar__url"><code>{url}</code></p>
            <div className="detail__actions">
              <button type="button" className="button button--primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
              <button type="button" className="button" onClick={rotate} disabled={busy}>{busy ? 'Working…' : 'Generate a new link'}</button>
            </div>
            <p className="muted small">
              Anyone with this link can see your bookings, so treat it like a password. Generating a new link stops the old one working.
              {calendar.rotatedAt && ` Current link created ${formatDateTime(calendar.rotatedAt)}.`}
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">How to subscribe</h2>
        <dl className="facts facts--stacked">
          <dt>iPhone or iPad</dt>
          <dd>Settings → Apps → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, then paste the link.</dd>
          <dt>Mac Calendar</dt>
          <dd>File → New Calendar Subscription, paste the link. Set "Auto-refresh" to every hour.</dd>
          <dt>Google Calendar</dt>
          <dd>On the web, next to "Other calendars" press + → From URL, paste the link. Google refreshes subscribed calendars a few times a day.</dd>
        </dl>
      </div>
      </div>
    </section>
  );
}

export default function AdminApp() {
  const [session, setSession] = useState(getSession);
  const [route, navigate] = useAdminRoute();

  useEffect(() => {
    document.title = 'Bookings · Perfect Events NI';
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  if (!session) return <Login onSignedIn={setSession} />;

  return (
    <div className="admin">
      <header className="admin__bar">
        <button type="button" className="admin__brand" onClick={() => navigate(null)}>
          Perfect Events NI <span className="muted">/ bookings</span>
        </button>
        <div className="admin__user">
          <button type="button" className="button button--link" onClick={() => navigate(CALENDAR_ROUTE)}>Calendar</button>
          <span className="muted small">{session.email}</span>
          <button type="button" className="button button--link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="admin__main">
        {route === CALENDAR_ROUTE ? (
          <CalendarPage onBack={() => navigate(null)} onAuthLost={signOut} />
        ) : route ? (
          <BookingDetail id={route} onBack={() => navigate(null)} onAuthLost={signOut} />
        ) : (
          <BookingList onOpen={navigate} onAuthLost={signOut} />
        )}
      </main>
    </div>
  );
}
