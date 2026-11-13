const ZONE = 'Europe/Kyiv';
const HALF_HOUR = 30 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('uk-UA', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const offsetFormat = new Intl.DateTimeFormat('en', {
  timeZone: ZONE, timeZoneName: 'shortOffset',
});
export function dateKey(date) {
  const parts = Object.fromEntries(dateFormat.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function dayKey(offset, now = new Date()) {
  // Calendar arithmetic must start from the Kyiv date, not the browser's date.
  const date = new Date(`${dateKey(now)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function buildDaySlots(day, entries = []) {
  const starts = [];
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight)) throw new Error('Invalid day');
  // Scan real instants to preserve skipped/repeated hours on DST transition days.
  for (let time = midnight - 12 * 3600000; time < midnight + 36 * 3600000; time += HALF_HOUR) {
    if (dateKey(new Date(time)) === day) starts.push(time);
  }
  const values = new Map(entries.map(e => [Date.parse(e.dateTime), e.availability]));
  const transition = starts.length !== 48;
  const label = time => {
    const date = new Date(time);
    const offset = offsetFormat.formatToParts(date).find(p => p.type === 'timeZoneName').value;
    return timeFormat.format(date) + (transition ? ` ${offset}` : '');
  };
  return starts.map((start, index) => ({
    start, end: start + HALF_HOUR,
    from: label(start), to: index === starts.length - 1 ? '24:00' : label(start + HALF_HOUR),
    state: ({ 0: 'on', 1: 'off', 2: 'maybe' })[values.get(start)] ?? 'unknown',
  }));
}
