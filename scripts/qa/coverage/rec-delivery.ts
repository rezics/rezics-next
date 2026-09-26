import type { CaseDeclarations } from './declaration.ts';

const context = 'tests/qa/integration/recommendation-context.test.ts';
const generation = 'tests/qa/integration/recommendation-generation.test.ts';
const contextGate = { tier: 'integration', file: context,
  name: 'REC01/REC05: current private Context selection gates an eligible zero-score Work' } as const;

export const recDeliveryCases: CaseDeclarations = {
  REC01: [
    contextGate,
    { tier: 'integration', file: generation,
      name: 'REC01: a semantic basis is denied when its current Context proof is unavailable' },
    { tier: 'integration', file: generation,
      name: 'REC01: positive scores precede eligible zero-score Works across one cursor' },
    { tier: 'integration', file: generation,
      name: 'REC01: a ranking counts only admitted signals of its declared population and exact basis' },
  ],
  REC05: [
    contextGate,
    { tier: 'integration', file: generation,
      name: 'REC05: an account erasure withholds its viewer without disclosing a target' },
    { tier: 'integration', file: generation,
      name: 'REC05: erased rating contributor invalidates the old generation and rebuild omits the signal' },
    { tier: 'integration', file: generation,
      name: 'REC05: private or erased candidates are withheld at delivery without counts or reasons' },
  ],
};
