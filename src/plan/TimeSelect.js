// A time picker as a plain select in 15-minute steps. The browser's native
// time input scrolls endlessly through every minute; a DJ's running order
// only needs quarter hours. A saved value off the grid is kept as an option.

const STEP_MINUTES = 15;

const pad = (n) => String(n).padStart(2, '0');

export const TIME_OPTIONS = Array.from({ length: (24 * 60) / STEP_MINUTES }, (_, i) => {
  const minutes = i * STEP_MINUTES;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
});

export default function TimeSelect({ value, onChange, disabled, ...rest }) {
  const options = value && !TIME_OPTIONS.includes(value) ? [value, ...TIME_OPTIONS].sort() : TIME_OPTIONS;
  return (
    <select value={value || ''} onChange={onChange} disabled={disabled} {...rest}>
      <option value="">—</option>
      {options.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}
