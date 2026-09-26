import type { CaseDeclarations } from './declaration.ts';

const native = { tier: 'integration' as const,
  file: 'tests/qa/integration/validation-command.test.ts',
  name: 'MODEL15/MODEL16/MODEL17/MODEL18/MODEL23/MODEL27: native validation and guards roll back invalid changes' };
const work = { tier: 'integration' as const,
  file: 'tests/qa/integration/validation-protection.test.ts',
  name: 'MODEL18/MODEL23: real protection and edit routes serialize absent protection and one success receipt' };
const content = { tier: 'integration' as const,
  file: 'tests/qa/integration/validation-content-protection.test.ts',
  name: 'MODEL18/MODEL23: Content draft and protection serialize an explicitly absent protection head' };

export const modelValidationCases: CaseDeclarations = {
  MODEL18: [native, work, content],
  MODEL23: [native, work, content],
};
