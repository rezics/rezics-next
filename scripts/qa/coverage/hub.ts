import type { CaseDeclarations } from './declaration.ts';

const file = 'tests/qa/integration/hub-api.test.ts';

export const hubCases: CaseDeclarations = {
  HUB01: [
    { tier: 'integration', file,
      name: 'HUB01/HUB04: inert Skill import retains files and missing requirements through exact private read' },
    { tier: 'integration', file,
      name: 'HUB01: a lost subtype write repairs from the existing Content receipt on the same key' },
    { tier: 'integration', file,
      name: 'HUB01: same-key concurrent imports retain one Content revision and one subtype receipt' },
  ],
  HUB02: [{ tier: 'integration', file,
    name: 'HUB02: Prompt parameter schemas and examples retain exact revisions and stale edits' }],
  HUB04: [{ tier: 'integration', file,
    name: 'HUB01/HUB04: inert Skill import retains files and missing requirements through exact private read' }],
};
