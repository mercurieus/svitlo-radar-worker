import { describe, it, expect } from 'vitest';
import { buildDaySlots, dayKey } from '../public/schedule.js';

describe('Kyiv schedule timeline', () => {
  it('uses the Kyiv calendar date around UTC midnight', () => {
    const now = new Date('2026-11-12T23:30:00Z');
    expect(dayKey(0, now)).toBe('2026-11-13');
    expect(dayKey(1, now)).toBe('2026-11-14');
  });
  it('advances the local date correctly over a daylight-saving transition', () => {
    expect(dayKey(1, new Date('2026-03-28T21:30:00Z'))).toBe('2026-03-29');
  });
  it('maps UTC entries into local slots and leaves absent/invalid states unknown', () => {
    const slots = buildDaySlots('2026-11-13', [
      { dateTime: '2026-11-12T22:00:00Z', availability: 0 },
      { dateTime: '2026-11-12T22:30:00Z', availability: 1 },
      { dateTime: '2026-11-12T23:00:00Z', availability: 2 },
      { dateTime: '2026-11-12T23:30:00Z', availability: 9 },
      { dateTime: '2026-11-11T22:00:00Z', availability: 1 },
    ]);
    expect(slots).toHaveLength(48);
    expect(slots.slice(0,5).map(s=>s.state)).toEqual(['on','off','maybe','unknown','unknown']);
    expect(slots[0].from).toBe('00:00');
    expect(slots.at(-1).to).toBe('24:00');
  });
  it('renders a 23-hour spring day without inventing missing local hours', () => {
    const slots = buildDaySlots('2026-03-29');
    expect(slots).toHaveLength(46);
    expect(slots.some(s=>s.from.startsWith('03:'))).toBe(false);
  });
  it('preserves both occurrences of the repeated autumn hour', () => {
    const slots = buildDaySlots('2026-10-25', [
      { dateTime: '2026-10-25T00:00:00Z', availability: 1 },
      { dateTime: '2026-10-25T01:00:00Z', availability: 0 },
    ]);
    expect(slots).toHaveLength(50);
    const repeated = slots.filter(s=>s.from.startsWith('03:00'));
    expect(repeated.map(s=>s.state)).toEqual(['off','on']);
    expect(repeated[0].from).not.toBe(repeated[1].from);
  });
});
