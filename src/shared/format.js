// Labels and formatters shared by the admin screen and the client planning page.

export const EVENT_TYPE_LABELS = {
  wedding: 'Wedding',
  private: 'Private event',
  corporate: 'Corporate event',
  'pa-hire': 'PA hire'
};

export const WEDDING_PACKAGE_LABELS = {
  'full-night': 'Full night',
  'after-band': 'After band',
  'not-sure': 'Not sure yet'
};

export const labelFor = (labels, value, fallback = 'Not specified') => (value ? labels[value] || value : fallback);

export const formatEventDate = (iso, { long = false } = {}) => {
  if (!iso || iso === 'unknown') return 'Date TBC';
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
    year: 'numeric'
  });
};

export const formatDateTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// The planning form's fields, in the order they are shown. Kept in step with
// FIELDS in aws/lambda/planning-form/index.js, which is what validates them.
// `songs` fields hold a list of picked song records (or, for forms filled in
// before the picker existed, plain text).
export const PLANNING_SECTIONS = [
  {
    title: 'Timings and guests',
    hint: 'Rough times are fine. We plan the night around these.',
    fields: [
      { key: 'guestCount', label: 'Number of guests', type: 'number', placeholder: 'Roughly' },
      { key: 'setupAccessTime', label: 'When can we get in to set up?', type: 'time' },
      { key: 'guestArrivalTime', label: 'Guests arrive', type: 'time' },
      { key: 'mealTime', label: 'Meal served', type: 'time', eventTypes: ['wedding', 'corporate'] },
      { key: 'speechesTime', label: 'Speeches', type: 'time', eventTypes: ['wedding'] },
      { key: 'djStartTime', label: 'DJ starts', type: 'time' },
      { key: 'finishTime', label: 'Music must finish by', type: 'time' }
    ]
  },
  {
    title: 'Music',
    hint: 'Search for songs and add them. Anything under "do not play" stays off, no exceptions.',
    fields: [
      { key: 'firstDance', label: 'First dance', type: 'songs', max: 1, eventTypes: ['wedding'] },
      { key: 'parentDances', label: 'Parent dances (if any)', type: 'songs', max: 5, eventTypes: ['wedding'] },
      { key: 'lastSong', label: 'Last song of the night', type: 'songs', max: 1 },
      { key: 'mustPlay', label: 'Must play', type: 'songs', max: 100, allowImport: true, hint: 'The ones the night is not complete without.' },
      { key: 'doNotPlay', label: 'Do not play', type: 'songs', max: 100, allowImport: true },
      { key: 'musicStyle', label: 'What gets your crowd going?', type: 'long', placeholder: 'Eras, genres, artists, the vibe you want' },
      { key: 'announcements', label: 'Anything to announce?', type: 'long', placeholder: 'Cake cutting, toasts, a birthday in the room' }
    ]
  },
  {
    title: 'Venue',
    hint: 'So we can sort access and set-up directly with the venue.',
    fields: [
      { key: 'venueContactName', label: 'Venue contact name', type: 'short' },
      { key: 'venueContactPhone', label: 'Venue contact phone', type: 'short' },
      { key: 'accessNotes', label: 'Parking, load-in, stairs, power', type: 'long' }
    ]
  },
  {
    title: 'Anything else',
    fields: [{ key: 'extraNotes', label: 'Anything else we should know?', type: 'long' }]
  }
];

// Whether a field is shown for this kind of event. Fields with no eventTypes
// apply to every event.
export const fieldApplies = (field, eventType) => !field.eventTypes || field.eventTypes.includes(eventType);

export const PLANNING_FIELDS = PLANNING_SECTIONS.flatMap((section) => section.fields);

// A song list as "Artist – Title" lines. Legacy plain text passes through.
export const songsToText = (value) => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((s) => (s.artist ? `${s.artist} – ${s.title}` : s.title)).join('\n');
};

// Every song list in the answers as one block of text, ready for a DJ's prep.
export const answersToSetlistText = (answers = {}) =>
  PLANNING_FIELDS.filter((f) => f.type === 'songs' && answers[f.key] && songsToText(answers[f.key]))
    .map((f) => `${f.label}\n${songsToText(answers[f.key])}`)
    .join('\n\n');

export const PLANNING_FIELD_LABELS = Object.fromEntries(
  PLANNING_SECTIONS.flatMap((section) => section.fields.map((f) => [f.key, f.label]))
);
