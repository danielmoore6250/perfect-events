// Small stroke icons for the planning page and admin song lists. One stroke
// weight, one size, so they read as a set rather than a mix of glyphs.

const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false };

export const PlayIcon = () => (
  <svg {...base} fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z" /></svg>
);
export const StopIcon = () => (
  <svg {...base} fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
);
export const CloseIcon = () => (
  <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const PlusIcon = () => (
  <svg {...base}><path d="M12 5v14M5 12h14" /></svg>
);
export const SearchIcon = () => (
  <svg {...base}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const NoteIcon = () => (
  <svg {...base}><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>
);
