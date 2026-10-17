import { expect, test } from 'bun:test';
import { mainConfig } from '../src/config.ts';
import { rankingClock } from '../src/modules/rankings/clock.ts';
import { rankingBuckets } from '../src/modules/rankings/projection.ts';
import { checkProductionEnv } from '../../../scripts/ops/production-env.ts';

const at = '2024-03-31T23:59:59.999Z';
const qa = { REZICS_STACK_PROFILE: 'qa', REZICS_QA_RUN_ID: 'ranking-replay', REZICS_QA_RANKING_AT: at };

test('ranking source and read clocks agree across UTC day, week and month boundaries', () => {
  const clock = rankingClock(qa);
  const after = new Date('2024-04-01T00:00:00.000Z');
  for (const interval of ['day', 'week', 'month'] as const) {
    const source = rankingBuckets(clock.at(new Date(at)), interval);
    expect(rankingBuckets(after, interval).current).not.toBe(source.current);
    expect(rankingBuckets(clock.at(after), interval)).toEqual(source);
    expect(rankingBuckets(clock.at(), interval)).toEqual(source);
  }
  // Mutating a returned Date cannot move the retained clock.
  clock.at().setUTCFullYear(2030);
  expect(clock.at().toISOString()).toBe(at);
});

test('unconfigured rankings use event time for scores and wall time for reads', () => {
  const clock = rankingClock({});
  const event = new Date(at);
  expect(clock.at(event)).toBe(event);
  const before = Date.now(), now = clock.at().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});

test('startup refuses a ranking clock outside an admitted QA stack', () => {
  for (const environment of [
    { ...qa, NODE_ENV: 'production' },
    { ...qa, REZICS_STACK_PROFILE: 'dev' },
    { ...qa, REZICS_STACK_PROFILE: undefined },
    { ...qa, REZICS_QA_RUN_ID: undefined },
  ]) expect(() => mainConfig(environment)).toThrow('requires an admitted QA stack');
  for (const value of ['', 'invalid', '2024-02-30T00:00:00.000Z', '2024-04-01', '2024-04-01T00:00:00+00:00']) {
    expect(() => mainConfig({ ...qa, REZICS_QA_RANKING_AT: value })).toThrow('canonical UTC timestamp');
  }
  for (const value of [at, '']) {
    expect(() => checkProductionEnv({ REZICS_QA_RANKING_AT: value }, []))
      .toThrow('Production forbids REZICS_QA_RANKING_AT');
  }
});
