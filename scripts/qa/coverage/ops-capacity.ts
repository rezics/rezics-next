import type { CaseDeclarations } from './declaration.ts';

export const opsCapacityCases: CaseDeclarations = {
  OPS05: [{
    tier: 'load',
    file: 'tests/qa/load/ops-relay-bound.test.ts',
    name: 'OPS05: next relay batch seeks one indexed sequence regardless of unrelated backlog',
  }, {
    tier: 'load',
    file: 'tests/qa/load/fixture-public-corpus.test.ts',
    name: 'OPS05/SEARCH18: deterministic public graph plan scales with the imported corpus',
  }, {
    tier: 'load',
    file: 'tests/qa/load/public-query.test.ts',
    name: 'OPS05/SEARCH18/SEARCH19: bounded skewed Main, Realm and Content phrase load stays complete',
  }, {
    tier: 'load',
    file: 'tests/qa/load/ops-phase-d.test.ts',
    name: 'OPS05: named 100k host mix records latency, relay lag, memory and storage recovery',
  }],
  SEARCH18: [{
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH18: an exhausted native qualification can retry without a corpus fallback',
  }, {
    tier: 'load',
    file: 'tests/qa/load/fixture-public-corpus.test.ts',
    name: 'SEARCH18: fixture plans 10,000 distinct public MatchUnits with bounded phrase degrees',
  }, {
    tier: 'load',
    file: 'tests/qa/load/public-query.test.ts',
    name: 'OPS05/SEARCH18/SEARCH19: bounded skewed Main, Realm and Content phrase load stays complete',
  }, {
    tier: 'load',
    file: 'tests/qa/load/search-phase-d.test.ts',
    name: 'SEARCH18: restored 10k public units meet cold, degree, language, byte, cursor and retry bounds',
  }],
};
