import type { CaseDeclarations } from './declaration.ts';

const reasoning = { tier: 'integration' as const, file: 'tests/qa/integration/semantic-reasoning.test.ts',
  name: 'MODEL19/MODEL20: identity axioms are refused and Source/Realm closure cannot qualify or authorize facts' };
const reasoningProfile = { tier: 'model' as const, file: 'model/tests/reasoning-profile.test.ts',
  name: 'MODEL20: NoEntailment rejects union and partial closure outputs without fallback, counts or authority' };
const unavailable = { tier: 'model' as const, file: 'model/tests/reasoning-profile.test.ts',
  name: 'MODEL20: unavailable selection does not become absence, fallback or authorization' };
const generation = { tier: 'integration' as const, file: 'tests/qa/integration/semantic-generation.test.ts',
  name: 'MODEL21/MODEL22: staging pins the exact model head and a prepared write cannot commit across a generation change' };

export const modelReasoningCases: CaseDeclarations = {
  MODEL19: [reasoning, { tier: 'model', file: 'model/tests/reasoning-profile.test.ts',
    name: 'MODEL19: finite reasoning rejects identity-producing OWL axioms and keeps native IDs distinct' }],
  MODEL20: [reasoning, reasoningProfile, unavailable],
  MODEL22: [generation],
};
