// One preview player for the whole page, so starting a song stops the last one.
//
// Previews always stream through our own /music/preview route, which looks
// the track up and redirects to a current link. Stored preview links are not
// used: Deezer signs them and they expire within minutes of a search.

import { API_BASE } from '../config';

export const songKey = (s) => (s.source === 'manual' ? `manual:${s.title}|${s.artist}`.toLowerCase() : `${s.source}:${s.id}`);

export const previewSrc = (song) =>
  song && song.source !== 'manual' && song.id && song.previewUrl
    ? `${API_BASE}/music/preview?source=${encodeURIComponent(song.source)}&id=${encodeURIComponent(song.id)}`
    : null;

let audio = null;
let playingKey = null;
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn(playingKey));

const ensureAudio = () => {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'none';
    audio.addEventListener('ended', () => {
      playingKey = null;
      notify();
    });
    audio.addEventListener('error', () => {
      playingKey = null;
      notify();
    });
  }
  return audio;
};

export const togglePreview = async (key, url) => {
  const player = ensureAudio();
  if (playingKey === key) {
    player.pause();
    playingKey = null;
    notify();
    return;
  }
  player.pause();
  player.src = url;
  playingKey = key;
  notify();
  try {
    await player.play();
  } catch {
    // Only clear if this request is still the active one; a rejection from a
    // preview that was already replaced must not hide the newer one's state.
    if (playingKey === key) {
      playingKey = null;
      notify();
    }
  }
};

export const stopPreview = () => {
  if (audio) audio.pause();
  playingKey = null;
  notify();
};

export const subscribePreview = (fn) => {
  listeners.add(fn);
  fn(playingKey);
  return () => listeners.delete(fn);
};
