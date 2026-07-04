import { describe, it, expect } from 'vitest';
import {
  BRIEFING_TEMPLATE,
  composeMorningBriefing,
  msUntilNextBriefing,
  scheduleMorningBriefing,
} from '../atlas/briefing.js';

describe('Atlas briefing template', () => {
  it('states CEO, control surface, and quality gates', () => {
    expect(BRIEFING_TEMPLATE).toContain('Yusif Ganbarov');
    expect(BRIEFING_TEMPLATE).toContain('ANUS is control surface');
    expect(BRIEFING_TEMPLATE).toContain('consult swarm');
    expect(BRIEFING_TEMPLATE).toContain('Error classes');
  });
});

describe('composeMorningBriefing', () => {
  it('produces a 3-sentence Russian briefing + spend line, no bullet walls', () => {
    const text = composeMorningBriefing({
      night: 'бот работал стабильно',
      today: 'фаза phase1',
      awaitingCeo: 'ничего не блокирует',
    });
    expect(text).toContain('Ночью:');
    expect(text).toContain('Сегодня:');
    expect(text).toContain('Жду твоего решения:');
    expect(text).toContain('потрачено');
    // no bullet walls
    expect(text).not.toContain('\n- ');
  });
});

describe('msUntilNextBriefing (08:45 Baku = 04:45 UTC)', () => {
  it('schedules later the same day when it is before 08:45 Baku', () => {
    // 2026-07-05 00:00 UTC = 04:00 Baku → target 04:45 UTC same day
    const now = new Date('2026-07-05T00:00:00Z');
    const ms = msUntilNextBriefing(now);
    // 04:45 UTC - 00:00 UTC = 4h45m
    expect(ms).toBe((4 * 60 + 45) * 60 * 1000);
  });

  it('rolls to tomorrow when it is already past 08:45 Baku', () => {
    // 2026-07-05 05:00 UTC = 09:00 Baku → past 08:45, next is tomorrow 04:45 UTC
    const now = new Date('2026-07-05T05:00:00Z');
    const ms = msUntilNextBriefing(now);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // exactly 23h45m
    expect(ms).toBe((23 * 60 + 45) * 60 * 1000);
  });
});

describe('scheduleMorningBriefing', () => {
  it('returns a stop() that clears without firing early', () => {
    let fired = 0;
    const handle = scheduleMorningBriefing(() => { fired += 1; }, new Date('2026-07-05T00:00:00Z'));
    handle.stop();
    expect(fired).toBe(0);
  });
});
