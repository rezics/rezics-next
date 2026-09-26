import type { CaseDeclarations } from './declaration.ts';

export const liveExportCases: CaseDeclarations = {
  LIVE01: [
    { tier: 'integration', file: 'tests/qa/integration/source-run-acquisition.test.ts',
      name: 'LIVE01: a source field that is added, removed or changed between runs is reported with its declared disposition' },
    { tier: 'integration', file: 'tests/qa/integration/source-run-vndb.test.ts',
      name: 'LIVE01/LIVE09: VNDB dispositions compare every frozen field and a mid-run source change waits for the next run' },
    { tier: 'integration', file: 'tests/qa/integration/export-source-vndb.test.ts',
      name: 'LIVE01/LIVE07: frozen VNDB concept evidence exports exact source dispositions with qualified residuals' },
  ],
  LIVE07: [
    { tier: 'integration', file: 'tests/qa/integration/export-planner.test.ts',
      name: 'LIVE07: lexical time and quantity, language, unknown, absent, null, zero and false round-trip exactly' },
    { tier: 'integration', file: 'tests/qa/integration/export-source-vndb.test.ts',
      name: 'LIVE01/LIVE07: frozen VNDB concept evidence exports exact source dispositions with qualified residuals' },
    { tier: 'integration', file: 'tests/qa/integration/export-source-vndb.test.ts',
      name: 'LIVE07: source concepts stay distinct while a named narrower concept round-trips in two accepted Context meanings' },
  ],
  LIVE09: [
    { tier: 'integration', file: 'tests/qa/integration/source-run-acquisition.test.ts',
      name: 'LIVE09: a run freezes each request capture, reuses it across consumers and retries, and the next run refreshes' },
    { tier: 'integration', file: 'tests/qa/integration/source-run-vndb.test.ts',
      name: 'LIVE01/LIVE09: VNDB dispositions compare every frozen field and a mid-run source change waits for the next run' },
  ],
  LIVE11: [
    { tier: 'integration', file: 'tests/qa/integration/source-run-acquisition.test.ts',
      name: 'LIVE11: a surface behind provider access is unqualified with no bypass or guessed values' },
    { tier: 'integration', file: 'tests/qa/integration/source-run-vndb.test.ts',
      name: 'LIVE11: a VNDB concept surface behind provider access is unqualified and cannot become guessed data' },
  ],
  LIVE12: [{ tier: 'integration', file: 'tests/qa/integration/source-run-feed.test.ts',
    name: 'LIVE12: bootstrap baseline then change windows handle overlap and gaps, resume from frozen pages and stay bounded' }],
};
