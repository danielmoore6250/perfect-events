// The Party music section of the planning form: one search with an "Adding
// to" selector, and the lists it feeds, plus shared playlist links.

import { useState, useEffect, useRef } from 'react';
import { API_BASE } from '../config';
import { subscribePreview, songKey } from '../shared/preview';
import { CloseIcon, PlusIcon, NoteIcon } from '../shared/icons';
import { PROVIDER_LABELS } from '../shared/format';
import { SongRow } from './SongRow';
import SongFinder from './SongFinder';

export { PreviewButton, SongArt, SongRow } from './SongRow';

// A shared playlist link with its title and cover, and for Apple Music and
// Deezer links a way to pull the songs into a list.
export function PlaylistLinkRow({ link, action, onImport, importing }) {
  return (
    <li className="song">
      {link.thumbnail ? <img className="song__art" src={link.thumbnail} alt="" loading="lazy" /> : <span className="song__art song__art--blank" aria-hidden="true"><NoteIcon /></span>}
      <span className="song__text">
        <a className="song__title" href={link.url} target="_blank" rel="noreferrer">{link.title || 'Playlist'}</a>
        <span className="song__artist muted small">{PROVIDER_LABELS[link.provider] || link.provider}</span>
      </span>
      {onImport && (link.provider === 'apple' || link.provider === 'deezer') && (
        <button type="button" className="button button--small" onClick={() => onImport(link)} disabled={importing} aria-label={`Import songs from ${link.title || 'playlist'}`}>
          {importing ? 'Importing…' : 'Import songs'}
        </button>
      )}
      {action}
    </li>
  );
}

export default function MusicPlanner({ fields, answers, onChange, disabled = false }) {
  const songFields = fields.filter((f) => f.type === 'songs');
  const linkField = fields.find((f) => f.type === 'links') || null;
  const [destination, setDestination] = useState(() => (songFields.find((f) => f.key === 'mustPlay') || songFields[0]).key);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState(null); // null | 'import'
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [importingKey, setImportingKey] = useState(null);
  const [note, setNote] = useState('');
  const [playing, setPlaying] = useState(null);
  const finderRef = useRef(null);

  useEffect(() => subscribePreview(setPlaying), []);

  // If the destination list disappears (wedding-only fields on a non-wedding)
  // or is legacy text, fall back to the first list that can take songs.
  useEffect(() => {
    const ok = songFields.find((f) => f.key === destination && typeof answers[f.key] !== 'string');
    if (!ok) {
      const first = songFields.find((f) => typeof answers[f.key] !== 'string') || songFields[0];
      if (first && first.key !== destination) setDestination(first.key);
    }
  }, [songFields, destination, answers]);

  const songsOf = (key) => (Array.isArray(answers[key]) ? answers[key] : []);
  // A list still holding typed-in text from before the picker is not a target:
  // adding to it would silently replace the text. It becomes one after the
  // client chooses "Use song search instead".
  const isLegacy = (key) => typeof answers[key] === 'string';
  const targetable = songFields.filter((f) => !isLegacy(f.key));
  const field = targetable.find((f) => f.key === destination) || targetable[0] || songFields[0];
  const current = songsOf(field.key);
  const full = current.length >= field.max;
  const has = (song) => current.some((s) => songKey(s) === songKey(song));

  const target = (key) => {
    setDestination(key);
    setNote('');
    setError('');
    finderRef.current?.focus();
  };

  const add = (song) => {
    if (full || has(song) || isLegacy(field.key)) return;
    onChange(field.key, [...current, song]);
  };

  const remove = (key, song) => onChange(key, songsOf(key).filter((s) => songKey(s) !== songKey(song)));

  // Pulls a playlist's songs into the selected list (or Must play when the
  // selected list cannot take an import).
  const importSongs = async (url) => {
    const targetField = field.allowImport ? field : songFields.find((f) => f.allowImport && !isLegacy(f.key));
    if (!targetField) throw new Error('There is no list to import into.');
    const existing = songsOf(targetField.key);
    const res = await fetch(`${API_BASE}/music/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed');
    const hasIn = (song) => existing.some((s) => songKey(s) === songKey(song));
    const fresh = (data.songs || []).filter((s) => !hasIn(s));
    const added = fresh.slice(0, Math.max(targetField.max - existing.length, 0));
    if (added.length) onChange(targetField.key, [...existing, ...added]);
    return added.length === 0
      ? 'Nothing new to add from that playlist.'
      : `Added ${added.length} song${added.length === 1 ? '' : 's'} to ${targetField.label}${fresh.length > added.length ? ` (${fresh.length - added.length} left out, the list is full)` : ''}.`;
  };

  const importPlaylist = async () => {
    const url = importUrl.trim();
    if (!url || !field.allowImport) return;
    setImporting(true);
    setNote('');
    setError('');
    try {
      setNote(await importSongs(url));
      setImportUrl('');
      setPanel(null);
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const links = linkField && Array.isArray(answers[linkField.key]) ? answers[linkField.key] : [];
  const linksFull = linkField ? links.length >= linkField.max : true;

  const addLink = async () => {
    const url = linkUrl.trim();
    if (!url || !linkField || linksFull) return;
    setAddingLink(true);
    setLinkError('');
    try {
      const res = await fetch(`${API_BASE}/music/link?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not read that link');
      if (links.some((l) => l.url === data.url)) throw new Error('That playlist is already here.');
      onChange(linkField.key, [...links, { url: data.url, provider: data.provider, title: data.title, thumbnail: data.thumbnail }]);
      setLinkUrl('');
    } catch (err) {
      setLinkError(err.message || 'Could not read that link');
    } finally {
      setAddingLink(false);
    }
  };

  const removeLink = (link) => onChange(linkField.key, links.filter((l) => l.url !== link.url));

  const importFromLink = async (link) => {
    setImportingKey(link.url);
    setLinkError('');
    setNote('');
    try {
      setNote(await importSongs(link.url));
    } catch (err) {
      setLinkError(err.message || 'Import failed');
    } finally {
      setImportingKey(null);
    }
  };

  const switchFromLegacy = (key) => {
    if (window.confirm('Switch to song search? The text you typed before will be cleared so you can pick the songs properly.')) onChange(key, []);
  };

  return (
    <div className="music">
        {linkField && (
          <section className="music__list music__list--first" role="group" aria-label={linkField.label}>
            <header className="music__list-head">
              <h3 className="music__list-title">{linkField.label}</h3>
              {links.length > 0 && <span className="muted small">{links.length} / {linkField.max}</span>}
            </header>
            {links.length > 0 ? (
              <ul className="songlist">
                {links.map((link) => (
                  <PlaylistLinkRow
                    key={link.url}
                    link={link}
                    onImport={disabled ? null : importFromLink}
                    importing={importingKey === link.url}
                    action={
                      !disabled && (
                        <button type="button" className="song__btn song__remove" onClick={() => removeLink(link)} aria-label={`Remove ${link.title || 'playlist'}`}><CloseIcon /></button>
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="music__empty muted small">{linkField.hint}</p>
            )}
            {!disabled && !linksFull && (
              <div className="music__panel music__panel--link" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}>
                <input type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="Paste a playlist link" aria-label="Playlist link to add" />
                <button type="button" className="button button--small" onClick={addLink} disabled={addingLink || !linkUrl.trim()}>{addingLink ? 'Adding…' : 'Add playlist'}</button>
              </div>
            )}
            {linkError && <p className="notice notice--error small" role="alert">{linkError}</p>}
          </section>
        )}

      {!disabled && (
        <div className="music__finder" role="group" aria-label="Add songs">
          <div className="music__bar">
            <label className="music__dest">
              <span>Adding to</span>
              <select value={destination} onChange={(e) => target(e.target.value)}>
                {fields.map((f) => {
                  const n = songsOf(f.key).length;
                  const legacy = isLegacy(f.key);
                  return (
                    <option key={f.key} value={f.key} disabled={legacy}>
                      {f.label}{legacy ? ' (typed in)' : n >= f.max ? ' (full)' : f.max > 1 && n > 0 ? ` (${n})` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <SongFinder
              ref={finderRef}
              onPick={add}
              disabled={full}
              placeholder={full ? `${field.label} is full` : 'Search for a song'}
              isAdded={has}
              playing={playing}
              compact={field.max === 1}
            />
          </div>

          {full && (
            <p className="muted small">
              {field.max === 1 ? `Remove the current ${field.label.toLowerCase()} song to choose another.` : `${field.label} is full. Remove a song to add another.`}
            </p>
          )}
          {error && <p className="notice notice--error small" role="alert">{error}</p>}
          {note && <p className="notice notice--ok small" role="status">{note}</p>}

          {panel === 'import' && field.allowImport ? (
            <div className="music__panel">
              <input type="url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="Paste an Apple Music or Deezer playlist link" aria-label="Playlist link" autoFocus />
              <button type="button" className="button button--small" onClick={importPlaylist} disabled={importing || !importUrl.trim() || full}>
                {importing ? 'Importing…' : `Import to ${field.label}`}
              </button>
              <button type="button" className="button button--link" onClick={() => setPanel(null)}>Cancel</button>
            </div>
          ) : (
            field.allowImport && (
              <p className="music__more muted small">
                <button type="button" className="button button--link" onClick={() => setPanel('import')}>Import a playlist</button>
              </p>
            )
          )}
        </div>
      )}

      <div className="music__lists">
        {songFields.map((f) => {
          const value = answers[f.key];
          const legacy = typeof value === 'string' ? value : null;
          const songs = songsOf(f.key);
          const isFull = songs.length >= f.max;
          return (
            <section className="music__list" role="group" aria-label={f.label} key={f.key}>
              <header className="music__list-head">
                <h3 className="music__list-title">{f.label}</h3>
                {f.max > 1 && songs.length > 0 && <span className="muted small">{songs.length} / {f.max}</span>}
                {!disabled && legacy === null && !isFull && (
                  <button type="button" className="button button--link music__add" onClick={() => target(f.key)} aria-label={`Add to ${f.label}`}>
                    <PlusIcon /> Add
                  </button>
                )}
              </header>

              {legacy !== null ? (
                <>
                  <label className="field">
                    <span className="visually-hidden">{f.label}</span>
                    <textarea rows={3} value={legacy} onChange={(e) => onChange(f.key, e.target.value)} disabled={disabled} />
                  </label>
                  {!disabled && <button type="button" className="button button--link" onClick={() => switchFromLegacy(f.key)}>Use song search instead</button>}
                </>
              ) : songs.length > 0 ? (
                <ul className="songlist">
                  {songs.map((song) => (
                    <SongRow
                      key={songKey(song)}
                      song={song}
                      playing={playing}
                      detail={false}
                      action={
                        !disabled && (
                          <button type="button" className="song__btn song__remove" onClick={() => remove(f.key, song)} aria-label={`Remove ${song.title}`}><CloseIcon /></button>
                        )
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="music__empty muted small">{f.hint || 'Nothing yet.'}</p>
              )}
            </section>
          );
        })}

      </div>
    </div>
  );
}
