import type { CaseDeclarations } from './declaration.ts';

/** Graph/search recovery ownership and index qualification (G-069). */
export const opsSearchCases: CaseDeclarations = {
  OPS09: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-ops-cold-rebuild.test.ts',
    name: 'OPS09: a cold public Content body read and exact RDF/Lucene rebuild stay within API and storage budgets',
  }, {
    tier: 'unit',
    file: 'scripts/operations/search-state.test.ts',
    name: 'OPS09: headroom requires the replacement index and reserve beside the current one',
  }],
  OPS13: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-ops-lock.test.ts',
    name: 'OPS13: a second JVM on the active TDB2 directory is refused and the owner keeps serving',
  }],
  OPS14: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-ops-quickstart.test.ts',
    name: 'OPS14: pinned graph quickstart keeps RDF/text bindings across restart and an independent probe exposes stale deletion',
  }],
  OPS15: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-ops-generation.test.ts',
    name: 'OPS15/OPS16: a crash retains the TDB2 receipt, fences text, and a pinned rebuild activates a qualified generation',
  }],
  OPS16: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-ops-generation.test.ts',
    name: 'OPS15/OPS16: a crash retains the TDB2 receipt, fences text, and a pinned rebuild activates a qualified generation',
  }, {
    tier: 'unit',
    file: 'scripts/operations/search-state.test.ts',
    name: 'OPS16: a changed analyzer or an absolute original path is refused before index work',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/content-projection-crash.test.ts',
    name: 'SEARCH15/OPS16: a crash between the TDB2 and Lucene commits suspends search until rebuild',
  }],
};
