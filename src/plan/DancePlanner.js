// The Dances section of a wedding's planning form: the first dance, then any
// dances the couple names themselves (father and daughter, groom and mother,
// the bridal party). Each takes one song, so an empty slot shows a search.

import { useState, useEffect } from 'react';
import { subscribePreview } from '../shared/preview';
import { CloseIcon, PlusIcon } from '../shared/icons';
import { SongRow } from './SongRow';
import SongFinder from './SongFinder';

const DANCE_SUGGESTIONS = ['Father and daughter', 'Groom and mother', 'Bridal party', 'Last dance'];

function DanceSlot({ song, onPick, onRemove, disabled, playing, label }) {
  if (song) {
    return (
      <ul className="songlist">
        <SongRow
          song={song}
          playing={playing}
          detail={false}
          action={!disabled && <button type="button" className="song__btn song__remove" onClick={onRemove} aria-label={`Remove ${song.title}`}><CloseIcon /></button>}
        />
      </ul>
    );
  }
  if (disabled) return <p className="music__empty muted small">No song chosen.</p>;
  return <SongFinder onPick={onPick} playing={playing} placeholder="Search for the song" label={`Search for the ${label} song`} compact />;
}

export default function DancePlanner({ firstDanceField, dancesField, answers, onChange, disabled = false }) {
  const [playing, setPlaying] = useState(null);
  useEffect(() => subscribePreview(setPlaying), []);

  const firstDance = Array.isArray(answers[firstDanceField.key]) ? answers[firstDanceField.key] : [];
  const legacyFirst = typeof answers[firstDanceField.key] === 'string' ? answers[firstDanceField.key] : null;
  const dances = Array.isArray(answers[dancesField.key]) ? answers[dancesField.key] : [];
  const full = dances.length >= dancesField.max;

  const setDances = (next) => onChange(dancesField.key, next);
  const updateDance = (index, patch) => setDances(dances.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  const removeDance = (index) => setDances(dances.filter((_, i) => i !== index));
  const addDance = () => {
    if (full) return;
    setDances([...dances, { name: '', song: null }]);
  };

  const switchFromLegacy = () => {
    if (window.confirm('Switch to song search? The text you typed before will be cleared so you can pick the song properly.')) onChange(firstDanceField.key, []);
  };

  return (
    <div className="music">
      <div className="music__lists">
        <section className="music__list" role="group" aria-label={firstDanceField.label}>
          <header className="music__list-head">
            <h3 className="music__list-title">{firstDanceField.label}</h3>
          </header>
          {legacyFirst !== null ? (
            <>
              <label className="field">
                <span className="visually-hidden">{firstDanceField.label}</span>
                <textarea rows={2} value={legacyFirst} onChange={(e) => onChange(firstDanceField.key, e.target.value)} disabled={disabled} />
              </label>
              {!disabled && <button type="button" className="button button--link" onClick={switchFromLegacy}>Use song search instead</button>}
            </>
          ) : (
            <DanceSlot
              song={firstDance[0] || null}
              onPick={(song) => onChange(firstDanceField.key, [song])}
              onRemove={() => onChange(firstDanceField.key, [])}
              disabled={disabled}
              playing={playing}
              label="first dance"
            />
          )}
        </section>

        <section className="music__list" role="group" aria-label={dancesField.label}>
          <header className="music__list-head">
            <h3 className="music__list-title">{dancesField.label}</h3>
            {dances.length > 0 && <span className="muted small">{dances.length} / {dancesField.max}</span>}
            {!disabled && !full && (
              <button type="button" className="button button--link music__add" onClick={addDance} aria-label="Add a dance">
                <PlusIcon /> Add a dance
              </button>
            )}
          </header>
          {dances.length === 0 ? (
            <p className="music__empty muted small">{dancesField.hint}</p>
          ) : (
            <ol className="dances">
              {dances.map((dance, index) => (
                <li className="dance" key={index} role="group" aria-label={dance.name ? `Dance: ${dance.name}` : `Dance ${index + 1}`}>
                  <div className="dance__head">
                    <input
                      type="text"
                      className="dance__name"
                      value={dance.name}
                      onChange={(e) => updateDance(index, { name: e.target.value })}
                      placeholder="Who is dancing? e.g. Father and daughter"
                      aria-label={`Name of dance ${index + 1}`}
                      maxLength={80}
                      list="dance-suggestions"
                      disabled={disabled}
                      autoFocus={!disabled && !dance.name && !dance.song}
                    />
                    {!disabled && (
                      <button type="button" className="song__btn song__remove" onClick={() => removeDance(index)} aria-label={`Remove dance ${dance.name || index + 1}`}><CloseIcon /></button>
                    )}
                  </div>
                  <DanceSlot
                    song={dance.song}
                    onPick={(song) => updateDance(index, { song })}
                    onRemove={() => updateDance(index, { song: null })}
                    disabled={disabled}
                    playing={playing}
                    label={dance.name || `dance ${index + 1}`}
                  />
                </li>
              ))}
            </ol>
          )}
          <datalist id="dance-suggestions">
            {DANCE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
          </datalist>
        </section>
      </div>
    </div>
  );
}
