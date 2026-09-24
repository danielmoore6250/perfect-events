// The Music section of the planning form: one search, and the lists it feeds.
//
// The client picks which list they are adding to, searches once, and presses
// Add. Lists are plain rows with a count and an Add shortcut that points the
// search at that list. Songs are records from the search service, or typed in
// when the catalogue does not have them.

import { useState, useEffect, useRef } from 'react';
import { API_BASE } from '../config';
import { togglePreview, subscribePreview, previewSrc, songKey } from '../shared/preview';
import { PlayIcon, StopIcon, CloseIcon, PlusIcon, SearchIcon, NoteIcon } from '../shared/icons';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

const formatDuration = (ms) => {
  if (typeof ms !== 'number') return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function PreviewButton({ song, playing }) {
  const src = previewSrc(song);
  if (!src) return null;
  const key = songKey(song);
  const isPlaying = playing === key;
  return (
    <button
      type="button"
      className={`song__btn song__play ${isPlaying ? 'song__play--on' : ''}`}
      onClick={() => togglePreview(key, src)}
      aria-label={isPlaying ? `Stop preview of ${song.title}` : `Preview ${song.title}`}
      title={isPlaying ? 'Stop' : '30-second preview'}
    >
      {isPlaying ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

export function SongArt({ song }) {
  return song.artwork ? (
    <img className="song__art" src={song.artwork} alt="" loading="lazy" />
  ) : (
    <span className="song__art song__art--blank" aria-hidden="true"><NoteIcon /></span>
  );
}

export function SongRow({ song, playing, action, detail = true }) {
  return (
    <li className="song">
      <SongArt song={song} />
      <span className="song__text">
        <span className="song__title">{song.title}</span>
        <span className="song__artist muted small">
          {song.artist || (song.source === 'manual' ? 'Typed in' : '')}
          {detail && song.album ? ` · ${song.album}` : ''}
          {detail && song.durationMs ? ` · ${formatDuration(song.durationMs)}` : ''}
        </span>
      </span>
      <PreviewButton song={song} playing={playing} />
      {action}
    </li>
  );
}

export default function MusicPlanner({ fields, answers, onChange, disabled = false }) {
  const [destination, setDestination] = useState(() => (fields.find((f) => f.key === 'mustPlay') || fields[0]).key);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState(null); // null | 'manual' | 'import'
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState('');
  const [playing, setPlaying] = useState(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => subscribePreview(setPlaying), []);

  // If the destination list disappears (wedding-only fields on a non-wedding), fall back.
  useEffect(() => {
    if (!fields.some((f) => f.key === destination)) setDestination(fields[0]?.key);
  }, [fields, destination]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < MIN_QUERY) {
      setResults(null);
      setSearching(false);
      return undefined;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      setError('');
      try {
        const res = await fetch(`${API_BASE}/music/search?q=${encodeURIComponent(term)}&limit=10`, { signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Search failed');
        if (!controller.signal.aborted) setResults(data.songs || []);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setResults([]);
          setError(err.message || 'Search failed');
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query]);

  const songsOf = (key) => (Array.isArray(answers[key]) ? answers[key] : []);
  const field = fields.find((f) => f.key === destination) || fields[0];
  const current = songsOf(field.key);
  const full = current.length >= field.max;
  const has = (song) => current.some((s) => songKey(s) === songKey(song));

  const target = (key) => {
    setDestination(key);
    setNote('');
    setError('');
    inputRef.current?.focus();
  };

  const add = (song) => {
    if (full || has(song)) return;
    onChange(field.key, [...current, song]);
    if (field.max === 1) {
      setQuery('');
      setResults(null);
    }
  };

  const remove = (key, song) => onChange(key, songsOf(key).filter((s) => songKey(s) !== songKey(song)));

  const addManual = () => {
    const title = manualTitle.trim();
    if (!title || full) return;
    add({ source: 'manual', id: null, title, artist: manualArtist.trim(), album: null, artwork: null, previewUrl: null, url: null, durationMs: null });
    setManualTitle('');
    setManualArtist('');
    setPanel(null);
  };

  const importPlaylist = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    setNote('');
    setError('');
    try {
      const res = await fetch(`${API_BASE}/music/playlist?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Import failed');
      const fresh = (data.songs || []).filter((s) => !has(s));
      const added = fresh.slice(0, Math.max(field.max - current.length, 0));
      if (added.length) onChange(field.key, [...current, ...added]);
      setNote(
        added.length === 0
          ? 'Nothing new to add from that playlist.'
          : `Added ${added.length} song${added.length === 1 ? '' : 's'} to ${field.label}${fresh.length > added.length ? ` (${fresh.length - added.length} left out, the list is full)` : ''}.`
      );
      setImportUrl('');
      setPanel(null);
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const switchFromLegacy = (key) => {
    if (window.confirm('Switch to song search? The text you typed before will be cleared so you can pick the songs properly.')) onChange(key, []);
  };

  return (
    <div className="music">
      {!disabled && (
        <div className="music__finder">
          <div className="music__bar">
            <label className="music__dest">
              <span>Adding to</span>
              <select value={destination} onChange={(e) => target(e.target.value)}>
                {fields.map((f) => {
                  const n = songsOf(f.key).length;
                  return (
                    <option key={f.key} value={f.key}>
                      {f.label}{n >= f.max ? ' (full)' : f.max > 1 && n > 0 ? ` (${n})` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="music__input">
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={full ? `${field.label} is full` : 'Search for a song'}
                aria-label="Search for a song"
                autoComplete="off"
                disabled={full}
              />
            </div>
          </div>

          {full && (
            <p className="muted small">
              {field.max === 1 ? `Remove the current ${field.label.toLowerCase()} song to choose another.` : `${field.label} is full. Remove a song to add another.`}
            </p>
          )}
          {searching && <p className="muted small">Searching…</p>}
          {results && results.length > 0 && (
            <ul className="songlist songlist--results" aria-label="Search results">
              {results.map((song) => (
                <SongRow
                  key={songKey(song)}
                  song={song}
                  playing={playing}
                  action={
                    <button type="button" className="button button--small" onClick={() => add(song)} disabled={has(song) || full} aria-label={`Add ${song.title} by ${song.artist}`}>
                      {has(song) ? 'Added' : 'Add'}
                    </button>
                  }
                />
              ))}
            </ul>
          )}
          {results && results.length === 0 && !searching && !error && <p className="muted small">No matches. You can type it in instead.</p>}
          {error && <p className="notice notice--error small" role="alert">{error}</p>}
          {note && <p className="notice notice--ok small" role="status">{note}</p>}

          {panel === 'manual' ? (
            <div className="music__panel" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}>
              <input type="text" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="Song title" aria-label="Song title" maxLength={200} autoFocus />
              <input type="text" value={manualArtist} onChange={(e) => setManualArtist(e.target.value)} placeholder="Artist" aria-label="Artist" maxLength={200} />
              <button type="button" className="button button--small" onClick={addManual} disabled={!manualTitle.trim() || full} aria-label={`Add typed-in song to ${field.label}`}>Add to {field.label}</button>
              <button type="button" className="button button--link" onClick={() => setPanel(null)}>Cancel</button>
            </div>
          ) : panel === 'import' ? (
            <div className="music__panel">
              <input type="url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="Paste an Apple Music or Deezer playlist link" aria-label="Playlist link" autoFocus />
              <button type="button" className="button button--small" onClick={importPlaylist} disabled={importing || !importUrl.trim() || full}>
                {importing ? 'Importing…' : `Import to ${field.label}`}
              </button>
              <button type="button" className="button button--link" onClick={() => setPanel(null)}>Cancel</button>
            </div>
          ) : (
            <p className="music__more muted small">
              <button type="button" className="button button--link" onClick={() => setPanel('manual')}>Can't find it? Type it in</button>
              <span aria-hidden="true"> · </span>
              <button type="button" className="button button--link" onClick={() => setPanel('import')}>Import a playlist</button>
            </p>
          )}
        </div>
      )}

      <div className="music__lists">
        {fields.map((f) => {
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
