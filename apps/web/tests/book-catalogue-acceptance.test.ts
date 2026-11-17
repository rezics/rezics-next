import { expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  BookColdSearchTimeoutError,
  completeBookCatalogueAcceptance,
  writeBookCatalogueVerdicts,
  type BookCatalogueVerdicts,
  type BookScopeVerdict,
} from './native/book-catalogue-acceptance.ts';

for (const coldFailed of [false, true]) {
  for (const uiFailed of [false, true]) {
    test(`Book acceptance retains cold ${coldFailed ? 'failure' : 'success'} and UI ${uiFailed ? 'failure' : 'success'}`, async () => {
      const cold = coldFailed ? new BookColdSearchTimeoutError('original cold deadline') : undefined;
      const ui = new Error('original browser failure');
      const recorded: BookScopeVerdict[] = [];
      let browserCalls = 0;
      let failure: unknown;
      try {
        await completeBookCatalogueAcceptance(
          cold,
          async () => {
            browserCalls++;
            if (uiFailed) throw ui;
          },
          async (verdict) => {
            recorded.push(verdict);
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(browserCalls).toBe(1);
      expect(recorded).toEqual([uiFailed ? { outcome: 'failed', failure: ui.message } : { outcome: 'passed' }]);
      if (coldFailed || uiFailed) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([...(cold ? [cold] : []), ...(uiFailed ? [ui] : [])]);
      } else expect(failure).toBeUndefined();
    });
  }
}

test('Book verdict persistence retains UI unreached and cold success through setup failure', async () => {
  const path = resolve(
    import.meta.dir,
    `../../../.temp/book-catalogue-acceptance-${crypto.randomUUID()}/verdicts.json`,
  );
  const verdicts: BookCatalogueVerdicts = {
    coldSearch: { outcome: 'unreached' },
    ui: { outcome: 'unreached' },
  };
  try {
    await writeBookCatalogueVerdicts(path, verdicts);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(verdicts);
    verdicts.coldSearch = { outcome: 'passed' };
    await writeBookCatalogueVerdicts(path, verdicts);
    verdicts.setupFailure = 'actual setup timeout';
    await writeBookCatalogueVerdicts(path, verdicts);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      coldSearch: { outcome: 'passed' },
      ui: { outcome: 'unreached' },
      setupFailure: 'actual setup timeout',
    });
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});
