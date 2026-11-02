import { expect, test } from 'bun:test';
import { GROWTH_BASELINE } from './growth-baseline.ts';
import { type Bound } from './growth-bound.ts';
import { admitGrowthCheck } from './growth-config.ts';
import { checkGrowth, type GrowthCheck, type GrowthDatabase } from './growth.ts';

const database = new Proxy({} as GrowthDatabase, {
  get() {
    throw new Error('Invalid growth configuration reached the database');
  },
});

const validBounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

function hooks(): Pick<GrowthCheck, 'grow' | 'warmup' | 'operation'> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    grow: async () => {
      calls.push('grow');
    },
    warmup: async () => {
      calls.push('warmup');
    },
    operation: async () => {
      calls.push('operation');
    },
  };
}

test('invalid bound, slack and byte-bound configuration is rejected before grow, warmup or operation', async () => {
  const cases: { readonly extra: object; readonly field: string }[] = [
    { extra: { bounds: { rows: 'quadratic', blocks: 'constant', statements: 'constant' } }, field: 'bounds.rows' },
    { extra: { slack: { rows: { absolute: -1, relative: 0 } } }, field: 'slack.rows' },
    { extra: { byteBounds: { requestBytes: 'exponential' } }, field: 'byteBounds.requestBytes' },
  ];
  for (const { extra, field } of cases) {
    const { calls, ...rest } = hooks();
    await expect(
      checkGrowth(database, {
        name: 'malformed check',
        bounds: validBounds,
        ...rest,
        ...extra,
      } as GrowthCheck),
    ).rejects.toMatchObject({
      name: 'TypeError',
      message: expect.stringMatching(new RegExp(`^malformed check: ${field}:`)),
    });
    expect(calls).toEqual([]);
  }
});

test('admitted valid configuration keeps defaults, baseline rules and a stable snapshot', () => {
  const bounds = { rows: 'constant' as Bound, blocks: 'logarithmic' as Bound, statements: 'linear' as Bound };
  const slack = { blocks: { absolute: 4, relative: 0.5 } };
  const byteBounds = { requestBytes: 'constant' as Bound };
  const admitted = admitGrowthCheck({
    name: 'valid existing check',
    bounds,
    slack,
    byteBounds,
  });
  expect(admitted).toMatchObject({
    scales: [1, 8, 64],
    repetitions: 5,
    warmups: 1,
    rule: 'series',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'linear' },
    slack: { blocks: { absolute: 4, relative: 0.5 } },
    byteBounds: { requestBytes: 'constant' },
  });
  bounds.rows = 'linear';
  slack.blocks.absolute = -1;
  byteBounds.requestBytes = 'linear';
  expect(admitted.bounds.rows).toBe('constant');
  expect(admitted.slack?.blocks).toEqual({ absolute: 4, relative: 0.5 });
  expect(admitted.byteBounds?.requestBytes).toBe('constant');
  const listed = GROWTH_BASELINE[0];
  if (listed) expect(admitGrowthCheck({ name: listed.name, bounds }).rule).toBe('step');
});
