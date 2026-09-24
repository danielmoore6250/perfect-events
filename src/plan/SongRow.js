// One song as a row: artwork, title, artist, preview, and whatever action the
// list needs (add, remove). Shared by the planning page and the admin card.

import { togglePreview, previewSrc, songKey } from '../shared/preview';
import { PlayIcon, StopIcon, NoteIcon } from '../shared/icons';

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
