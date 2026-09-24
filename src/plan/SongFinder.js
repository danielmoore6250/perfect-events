// A catalogue search that hands back one picked song. Used by the party-music
// finder (with a destination selector) and by every single-song slot in the
// dances section. Includes the "type it in" fallback.

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { API_BASE } from '../config';
import { SearchIcon } from '../shared/icons';
import { SongRow } from './SongRow';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

const SongFinder = forwardRef(function SongFinder(
  { onPick, disabled = false, placeholder = 'Search for a song', label = 'Search for a song', isAdded = () => false, playing, autoFocus = false, compact = false },
  ref
) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }));

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

  const pick = (song) => {
    onPick(song);
    if (compact) {
      setQuery('');
      setResults(null);
    }
  };

  const addManual = () => {
    const title = manualTitle.trim();
    if (!title) return;
    pick({ source: 'manual', id: null, title, artist: manualArtist.trim(), album: null, artwork: null, previewUrl: null, url: null, durationMs: null });
    setManualTitle('');
    setManualArtist('');
    setManual(false);
  };

  return (
    <div className={`finder ${compact ? 'finder--compact' : ''}`}>
      <div className="music__input">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          disabled={disabled}
          autoFocus={autoFocus}
        />
      </div>
      {searching && <p className="muted small">Searching…</p>}
      {results && results.length > 0 && (
        <ul className="songlist songlist--results" aria-label="Search results">
          {results.map((song) => (
            <SongRow
              key={`${song.source}:${song.id}`}
              song={song}
              playing={playing}
              action={
                <button type="button" className="button button--small" onClick={() => pick(song)} disabled={disabled || isAdded(song)} aria-label={`Add ${song.title} by ${song.artist}`}>
                  {isAdded(song) ? 'Added' : 'Add'}
                </button>
              }
            />
          ))}
        </ul>
      )}
      {results && results.length === 0 && !searching && !error && <p className="muted small">No matches. You can type it in instead.</p>}
      {error && <p className="notice notice--error small" role="alert">{error}</p>}

      {manual ? (
        <div className="music__panel" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}>
          <input type="text" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="Song title" aria-label="Song title" maxLength={200} autoFocus />
          <input type="text" value={manualArtist} onChange={(e) => setManualArtist(e.target.value)} placeholder="Artist" aria-label="Artist" maxLength={200} />
          <button type="button" className="button button--small" onClick={addManual} disabled={!manualTitle.trim() || disabled} aria-label="Add typed-in song">Add</button>
          <button type="button" className="button button--link" onClick={() => setManual(false)}>Cancel</button>
        </div>
      ) : (
        !disabled && (
          <button type="button" className="button button--link finder__manual" onClick={() => setManual(true)}>Can't find it? Type it in</button>
        )
      )}
    </div>
  );
});

export default SongFinder;
