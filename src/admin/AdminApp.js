// The admin screen: sign in, list bookings, open one, edit its stage, date,
// pricing and notes. A working screen, kept deliberately plain.

import { useState, useEffect, useCallback } from 'react';
import '../styles/Admin.css';
import { getSession, signIn, completeNewPassword, clearSession } from './auth';
import { listBookings, getBooking, updateBooking } from './api';

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

const EVENT_TYPE_LABELS = {
  wedding: 'Wedding',
  private: 'Private event',
  corporate: 'Corporate event',
  'pa-hire': 'PA hire'
};
const WEDDING_PACKAGE_LABELS = {
  'full-night': 'Full night',
  'after-band': 'After band',
  'not-sure': 'Not sure yet'
};
const labelFor = (labels, value, fallback = 'Not specified') => (value ? labels[value] || value : fallback);

const todayIso = () => new Date().toISOString().slice(0, 10);

const formatEventDate = (iso, { long = false } = {}) => {
  if (!iso || iso === 'unknown') return 'Date TBC';
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
    year: 'numeric'
  });
};

const formatDateTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatMoney = (amount) =>
  typeof amount === 'number' ? `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

const reference = (id) => (id || '').slice(0, 8).toUpperCase();

// ---- Tiny router: /admin and /admin/<booking id> ---------------------------

const idFromPath = () => {
  const match = window.location.pathname.match(/^\/admin\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const useAdminRoute = () => {
  const [bookingId, setBookingId] = useState(idFromPath);

  useEffect(() => {
    const onPop = () => setBookingId(idFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((id) => {
    const path = id ? `/admin/${encodeURIComponent(id)}` : '/admin';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setBookingId(id || null);
    window.scrollTo(0, 0);
  }, []);

  return [bookingId, navigate];
};

// ---- Screens ---------------------------------------------------------------

function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [cognitoSession, setCognitoSession] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const needsNewPassword = Boolean(cognitoSession);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (needsNewPassword) {
        if (newPassword !== confirmPassword) throw new Error('The new passwords do not match.');
        onSignedIn(await completeNewPassword(email.trim(), newPassword, cognitoSession));
        return;
      }
      const result = await signIn(email.trim(), password);
      if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
        setCognitoSession(result.cognitoSession);
      } else {
        onSignedIn(result.session);
      }
    } catch (err) {
      setError(err.message || 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin admin--centered">
      <form className="login" onSubmit={submit}>
        <p className="admin__eyebrow">Perfect Events NI</p>
        <h1 className="login__title">{needsNewPassword ? 'Choose a password' : 'Admin sign in'}</h1>

        {needsNewPassword ? (
          <>
            <p className="login__hint">
              First sign-in. Pick a new password: at least 12 characters with upper and lower case letters and a number.
            </p>
            <label className="field">
              <span>New password</span>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required autoFocus />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
          </>
        )}

        {error && <p className="notice notice--error" role="alert">{error}</p>}

        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Please wait…' : needsNewPassword ? 'Set password and sign in' : 'Sign in'}
        </button>
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
  const visible = (bookings || [])
    .filter((b) => {
      if (stage === 'active') {
        if (CLOSED_STATUSES.has(b.status)) return false;
      } else if (stage !== 'all' && b.status !== stage) {
        return false;
      }
      if (!includePast && b.eventDate !== 'unknown' && b.eventDate < today) return false;
      return true;
    })
    // 'unknown' sorts after any YYYY-MM-DD, which is where a TBC date belongs.
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : 0));

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
        <p className="muted">No bookings match. {bookings.length > 0 && 'Try a different stage or include past dates.'}</p>
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
                <tr key={b.id} onClick={() => onOpen(b.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(b.id)}>
                  <td className={b.eventDate === 'unknown' ? 'muted' : ''}>{formatEventDate(b.eventDate)}</td>
                  <td>
                    <strong>{b.client?.name || 'Unknown'}</strong>
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
      apply(await updateBooking(id, changes));
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

export default function AdminApp() {
  const [session, setSession] = useState(getSession);
  const [bookingId, navigate] = useAdminRoute();

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
          <span className="muted small">{session.email}</span>
          <button type="button" className="button button--link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="admin__main">
        {bookingId ? (
          <BookingDetail id={bookingId} onBack={() => navigate(null)} onAuthLost={signOut} />
        ) : (
          <BookingList onOpen={navigate} onAuthLost={signOut} />
        )}
      </main>
    </div>
  );
}
