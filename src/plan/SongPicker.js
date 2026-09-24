// A list of songs with a catalogue search to add to it. Used for every song
// field on the planning form. Songs are records from the search service, or
// typed in by hand when the catalogue does not have them.

import { useState, useEffect, useRef } from 'react';
import { API_BASE } from '../config';
import { togglePreview, subscribePreview, previewSrc, songKey } from '../shared/preview';

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
      className={`song__play ${isPlaying ? 'song__play--on' : ''}`}
      onClick={() => togglePreview(key, src)}
      aria-label={isPlaying ? `Stop preview of ${song.title}` : `Preview ${song.title}`}
      title={isPlaying ? 'Stop' : '30-second preview'}
    >
      {isPlaying ? '■' : '▶'}
    </button>
  );
}

function SongRow({ song, playing, action }) {
  return (
    <li className="song">
      {song.artwork ? <img className="song__art" src={song.artwork} alt="" loading="lazy" /> : <span className="song__art song__art--blank" aria-hidden="true">♪</span>}
      <span className="song__text">
        <span className="song__title">{song.title}</span>
        <span className="song__artist muted small">
          {song.artist || (song.source === 'manual' ? 'Typed in' : '')}
          {song.album ? ` · ${song.album}` : ''}
          {song.durationMs ? ` · ${formatDuration(song.durationMs)}` : ''}
        </span>
      </span>
      <PreviewButton song={song} playing={playing} />
      {action}
    </li>
  );
}

export default function SongPicker({ label, hint, value, onChange, max = 100, allowImport = false, disabled = false }) {
  const songs = Array.isArray(value) ? value : [];
  const legacyText = typeof value === 'string' ? value : null;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState('');
  const [playing, setPlaying] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => subscribePreview(setPlaying), []);

  // Debounced search; the previous request is abandoned when the text changes.
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
      // A request already in flight for the old text must not land on the new one.
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query]);

  const full = songs.length >= max;
  const has = (song) => songs.some((s) => songKey(s) === songKey(song));

  const add = (song) => {
    if (full || has(song)) return;
    onChange([...songs, song]);
    if (max === 1) {
      setQuery('');
      setResults(null);
    }
  };

  const remove = (song) => onChange(songs.filter((s) => songKey(s) !== songKey(song)));

  // Not a <form>: the picker already sits inside the page's form, and a nested
  // form's submit would bubble up and send the whole page.
  const addManual = () => {
    const title = manualTitle.trim();
    if (!title) return;
    add({ source: 'manual', id: null, title, artist: manualArtist.trim(), album: null, artwork: null, previewUrl: null, url: null, durationMs: null });
    setManualTitle('');
    setManualArtist('');
    setShowManual(false);
  };

  const importPlaylist = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    setImportNote('');
    setError('');
    try {
      const res = await fetch(`${API_BASE}/music/playlist?url=${encodeURIComponent(url)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Import failed');
      const fresh = (data.songs || []).filter((s) => !has(s));
      const room = Math.max(max - songs.length, 0);
      const added = fresh.slice(0, room);
      if (added.length) onChange([...songs, ...added]);
      setImportNote(
        added.length === 0
          ? 'Nothing new to add from that playlist.'
          : `Added ${added.length} song${added.length === 1 ? '' : 's'}${fresh.length > added.length ? ` (list is full, ${fresh.length - added.length} left out)` : ''}.`
      );
      setImportUrl('');
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const switchFromLegacy = () => {
    if (window.confirm('Switch to song search? The text you typed before will be cleared so you can pick the songs properly.')) onChange([]);
  };

  return (
    <div className="picker" role="group" aria-label={label}>
      <div className="picker__head">
        <span className="picker__label">{label}</span>
        {max > 1 && songs.length > 0 && <span className="muted small">{songs.length} / {max}</span>}
      </div>
      {hint && <p className="muted small picker__hint">{hint}</p>}

      {legacyText !== null ? (
        <>
          <label className="field">
            <span className="visually-hidden">{label}</span>
            <textarea rows={3} value={legacyText} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
          </label>
          {!disabled && (
            <button type="button" className="button button--link" onClick={switchFromLegacy}>Use song search instead</button>
          )}
        </>
      ) : (
        <>
          {songs.length > 0 && (
            <ul className="songlist">
              {songs.map((song) => (
                <SongRow
                  key={songKey(song)}
                  song={song}
                  playing={playing}
                  action={
                    !disabled && (
                      <button type="button" className="song__remove" onClick={() => remove(song)} aria-label={`Remove ${song.title}`}>×</button>
                    )
                  }
                />
              ))}
            </ul>
          )}

          {!disabled && !full && (
            <div className="picker__search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={max === 1 ? 'Search for the song' : 'Search for a song to add'}
                aria-label={`Search songs for ${label}`}
                autoComplete="off"
              />
              {searching && <span className="muted small">Searching…</span>}
              {results && results.length > 0 && (
                <ul className="songlist songlist--results">
                  {results.map((song) => (
                    <SongRow
                      key={songKey(song)}
                      song={song}
                      playing={playing}
                      action={
                        <button type="button" className="button button--small" onClick={() => add(song)} disabled={has(song)} aria-label={`Add ${song.title} by ${song.artist}`}>
                          {has(song) ? 'Added' : 'Add'}
                        </button>
                      }
                    />
                  ))}
                </ul>
              )}
              {results && results.length === 0 && !searching && !error && <p className="muted small">No matches. You can type it in below.</p>}
              {error && <p className="notice notice--error small">{error}</p>}

              {showManual ? (
                <div className="picker__manual" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}>
                  <input type="text" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="Song title" aria-label={`Song title for ${label}`} maxLength={200} autoFocus />
                  <input type="text" value={manualArtist} onChange={(e) => setManualArtist(e.target.value)} placeholder="Artist" aria-label={`Artist for ${label}`} maxLength={200} />
                  <button type="button" className="button button--small" onClick={addManual} disabled={!manualTitle.trim()}>Add</button>
                  <button type="button" className="button button--link" onClick={() => setShowManual(false)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="button button--link picker__manual-toggle" onClick={() => setShowManual(true)}>Can't find it? Type it in</button>
              )}

              {allowImport && (
                <div className="picker__import">
                  <input
                    type="url"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder="Paste an Apple Music or Deezer playlist link"
                    aria-label={`Playlist link to import into ${label}`}
                  />
                  <button type="button" className="button button--small" onClick={importPlaylist} disabled={importing || !importUrl.trim()}>
                    {importing ? 'Importing…' : 'Import playlist'}
                  </button>
                  {importNote && <span className="muted small">{importNote}</span>}
                </div>
              )}
            </div>
          )}
          {!disabled && full && max > 1 && <p className="muted small">That's the maximum for this list. Remove one to add another.</p>}
          {!disabled && full && max === 1 && <p className="muted small">Remove it to choose a different song.</p>}
        </>
      )}
    </div>
  );
}
