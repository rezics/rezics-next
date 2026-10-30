import { expect, test } from 'bun:test';
import { GROWTH_BASELINE } from './growth-baseline.ts';
import { checkGrowth, type GrowthCheck, type GrowthDatabase } from './growth.ts';

// Configuration errors must be reported before touching a database or running a fixture.
const database = new Proxy({} as GrowthDatabase, {
  get() {
    throw new Error('Invalid growth configuration reached the database');
  },
});

function check(name: string, rule?: GrowthCheck['rule']): GrowthCheck {
  return {
    name,
    ...(rule === undefined ? {} : { rule }),
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {
      throw new Error('Invalid growth configuration ran its fixture');
    },
    operation: async () => {
      throw new Error('Invalid growth configuration ran its operation');
    },
  };
}

test('every unsupported GROWTH_RULE value fails before measurement, including an empty value', async () => {
  const previous = process.env.GROWTH_RULE;
  try {
    for (const value of ['', 'step', 'Series', ' series', 'series ', 'unknown']) {
      process.env.GROWTH_RULE = value;
      for (const name of ['unlisted configuration check', ...GROWTH_BASELINE.slice(0, 1).map(({ name }) => name)]) {
        await expect(checkGrowth(database, check(name))).rejects.toMatchObject({
          name: 'TypeError',
          message: `${name}: GROWTH_RULE must be 'series' when set`,
        });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = previous;
  }
});

test('listed checks reject both explicit rules even with the series environment override', async () => {
  const previous = process.env.GROWTH_RULE;
  const entry = GROWTH_BASELINE[0];
  if (!entry) return;
  const { name } = entry;
  try {
    for (const override of [undefined, 'series']) {
      if (override === undefined) delete process.env.GROWTH_RULE;
      else process.env.GROWTH_RULE = override;
      for (const rule of ['step', 'series'] as const) {
        await expect(checkGrowth(database, check(name, rule))).rejects.toMatchObject({
          name: 'TypeError',
          message: expect.stringContaining(name),
        });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = previous;
  }
});

test('the shrinking baseline excludes harness tests and only records triage or verification reasons', () => {
  for (const entry of GROWTH_BASELINE) {
    expect(entry.file).not.toContain('/test/support/');
    expect(entry.reason).toMatch(/^(?:[BT]: docs\/research\/growth-shadow-triage-[\w-]+\.md|verification run)$/);
  }
});
