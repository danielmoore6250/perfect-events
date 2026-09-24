// One preview player for the whole page, so starting a song stops the last one.

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
