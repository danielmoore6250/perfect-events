// The client's planning page at /plan/<token>. Public, no sign-in: the token
// in the link is what identifies the booking.

import { useState, useEffect, useCallback } from 'react';
import '../styles/Admin.css';
import '../styles/Plan.css';
import { API_BASE } from '../config';
import { PLANNING_SECTIONS, PLANNING_FIELDS, fieldApplies, WEDDING_PACKAGE_LABELS, formatDateTime } from '../shared/format';
import MusicPlanner from './MusicPlanner';
import DancePlanner from './DancePlanner';
import { stopPreview } from '../shared/preview';

const tokenFromPath = () => {
  const match = window.location.pathname.match(/^\/plan\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
};

const emptyAnswers = () =>
  Object.fromEntries(PLANNING_FIELDS.map((f) => [f.key, ['songs', 'links', 'dances'].includes(f.type) ? [] : '']));

// Only the fields this form knows about; anything else on the record is left alone.
const knownAnswers = (answers = {}) =>
  Object.fromEntries(PLANNING_FIELDS.filter((f) => answers[f.key] !== undefined && answers[f.key] !== null).map((f) => [f.key, answers[f.key]]));

const sameAnswer = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

export default function PlanApp() {
  const [token] = useState(tokenFromPath);
  const [booking, setBooking] = useState(null);
  const [answers, setAnswers] = useState(emptyAnswers);
  const [saved, setSaved] = useState(null); // answers as last saved, for the dirty check
  const [status, setStatus] = useState('loading'); // loading | ready | invalid | error
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    document.title = 'Your event details · Perfect Events NI';
  }, []);

  const apply = useCallback((b) => {
    setBooking(b);
    const next = { ...emptyAnswers(), ...knownAnswers(b.answers) };
    // The guest count starts from the enquiry until the client changes it.
    if (next.guestCount === '' && b.guestCount) next.guestCount = String(b.guestCount);
    // Earlier forms had separate "crowd" and "announcements" boxes; fold any
    // text from them into the one box so nothing is lost.
    const carried = ['musicStyle', 'announcements'].map((k) => (typeof b.answers?.[k] === 'string' ? b.answers[k].trim() : '')).filter(Boolean);
    if (carried.length && !next.extraNotes) next.extraNotes = carried.join('\n\n');
    // Forms filled in before dances had names stored parent dances as a plain
    // list; carry them over as named dances so nothing is lost.
    const oldParent = b.answers?.parentDances;
    if (Array.isArray(oldParent) && oldParent.length && next.namedDances.length === 0) {
      next.namedDances = oldParent.map((song) => ({ name: 'Parent dance', song }));
    }
    setAnswers(next);
    setSaved(next);
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/plan/${token}`);
        if (res.status === 404) return setStatus('invalid');
        if (!res.ok) throw new Error();
        apply((await res.json()).booking);
        setStatus('ready');
      } catch {
        setStatus('error');
      }
    })();
  }, [token, apply]);

  const set = (key) => (e) => {
    setJustSaved(false);
    setAnswers((a) => ({ ...a, [key]: e.target.value }));
  };
  const setValue = (key) => (value) => {
    setJustSaved(false);
    setAnswers((a) => ({ ...a, [key]: value }));
  };

  const dirty = saved && Object.keys(answers).some((k) => !sameAnswer(answers[k], saved[k]));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/plan/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers })
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 423) {
        // The event crossed the lock boundary since the page loaded: go read-only
        // exactly as a fresh visit would, rather than leaving an editable form.
        setBooking((b) => ({ ...b, locked: true }));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not save. Please try again.');
      apply(data.booking);
      setJustSaved(true);
      stopPreview();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') {
    return <div className="admin plan"><p className="muted plan__center">Loading your event…</p></div>;
  }
  if (status === 'invalid') {
    return (
      <div className="admin plan">
        <div className="plan__brand">Perfect Events NI</div>
        <div className="plan__center">
          <h1 className="plan__title">This link isn't right</h1>
          <p className="muted">Check the link you were sent, or reply to our email and we'll send a fresh one.</p>
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="admin plan">
        <div className="plan__brand">Perfect Events NI</div>
        <div className="plan__center">
          <h1 className="plan__title">Something went wrong</h1>
          <p className="muted">Please try again in a moment.</p>
        </div>
      </div>
    );
  }

  const isWedding = booking.eventType === 'wedding';
  const eventType = booking.eventType;
  const locked = booking.locked;

  return (
    <div className="admin plan">
      <div className="plan__brand">Perfect Events NI</div>
      <header className="plan__head">
        <h1 className="plan__title">Hi {firstName(booking.clientName)}, let's plan your {booking.eventTypeLabel}</h1>
        <p className="plan__meta">
          {booking.eventDateLabel}
          {booking.venue ? ` · ${booking.venue}` : ''}
          {isWedding && booking.weddingPackage ? ` · ${WEDDING_PACKAGE_LABELS[booking.weddingPackage] || booking.weddingPackage}` : ''}
        </p>
        <p className="muted">
          Fill in what you know now and come back to this link any time to change it.
          {booking.eventDate ? ' It locks three days before the event so we can prepare.' : ''}
        </p>
      </header>

      {justSaved && !dirty && (
        <p className="notice notice--ok" role="status">
          Saved. We've got your details{booking.updatedAt ? ` (${formatDateTime(booking.updatedAt)})` : ''}. Come back any time to change them.
        </p>
      )}
      {locked && (
        <p className="notice notice--error" role="alert">
          Your event is only a few days away so this form is now locked. If something needs to change, reply to our email or call us.
        </p>
      )}

      <form className="plan__form" onSubmit={submit}>
        {PLANNING_SECTIONS.map((section) => {
          const fields = section.fields.filter((f) => fieldApplies(f, eventType));
          if (!fields.length) return null;
          return (
            <fieldset className="card plan__section" key={section.title} disabled={locked || busy}>
              <legend className="card__title">{section.title}</legend>
              {section.hint && <p className="muted small plan__hint">{section.hint}</p>}
              {fields.some((f) => f.type === 'dances') ? (
                <DancePlanner
                  firstDanceField={fields.find((f) => f.key === 'firstDance')}
                  dancesField={fields.find((f) => f.type === 'dances')}
                  answers={answers}
                  onChange={(key, value) => setValue(key)(value)}
                  disabled={locked || busy}
                />
              ) : fields.some((f) => f.type === 'songs') ? (
                <MusicPlanner
                  fields={fields.filter((f) => f.type === 'songs' || f.type === 'links')}
                  answers={answers}
                  onChange={(key, value) => setValue(key)(value)}
                  disabled={locked || busy}
                />
              ) : null}
              <div className={['time', 'number'].includes(section.fields[0].type) ? 'plan__grid' : 'plan__stack'}>
                {fields.filter((f) => !['songs', 'links', 'dances'].includes(f.type)).map((f) => (
                  <label className="field" key={f.key}>
                    <span>{f.label}</span>
                    {f.type === 'long' ? (
                      <textarea rows={4} value={answers[f.key]} onChange={set(f.key)} placeholder={f.placeholder} maxLength={3000} />
                    ) : f.type === 'time' ? (
                      <input type="time" value={answers[f.key]} onChange={set(f.key)} />
                    ) : f.type === 'number' ? (
                      <input type="number" inputMode="numeric" min="1" max="5000" step="1" value={answers[f.key]} onChange={set(f.key)} placeholder={f.placeholder} />
                    ) : (
                      <input type="text" value={answers[f.key]} onChange={set(f.key)} placeholder={f.placeholder} maxLength={200} />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}

        {error && <p className="notice notice--error" role="alert">{error}</p>}

        {!locked && (
          <div className="plan__actions">
            <button type="submit" className="button button--primary button--lg" disabled={busy || !dirty}>
              {busy ? 'Saving…' : booking.submittedAt ? 'Save changes' : 'Send us your details'}
            </button>
            {booking.submittedAt && <span className="muted small">Last saved {formatDateTime(booking.updatedAt)}</span>}
          </div>
        )}
      </form>

      <footer className="plan__foot muted small">
        Questions? Email <a href="mailto:enquiries@perfecteventsni.com">enquiries@perfecteventsni.com</a>
      </footer>
    </div>
  );
}
