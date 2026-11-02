import { expect, test } from 'bun:test';
import { assertBackgroundBound, type ReportSample } from './growth.ts';

const statement = 'SELECT id FROM records';

function sample(scale: number, rows?: number): ReportSample {
  return {
    scale,
    cost: rows === undefined ? {} : { backgroundCosts: { [statement]: { rows, blocks: 0, bounded: true } } },
  } as unknown as ReportSample;
}

test('background growth reports a costly intermediate scale and skips missing observations', () => {
  expect(() => assertBackgroundBound('poller', [sample(1, 10), sample(8, 100), sample(64, 10)])).toThrow(
    `poller: background statement with largest rows ${JSON.stringify(statement)}; rows per statement grows from 10 to 100 at scale 8, beyond default slack 2`,
  );
  expect(() => assertBackgroundBound('poller', [sample(1), sample(8, 100), sample(64)])).not.toThrow();
});
