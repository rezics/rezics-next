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
const protectedFootprint = { tier: 'integration' as const,
  file: 'tests/qa/integration/validation-protection.test.ts',
  name: 'MODEL15/MODEL16/MODEL17/MODEL24/MODEL27: protected Work rejects missing basis, footprint bypass and deadline' };
const requiredFocus = { tier: 'unit' as const,
  file: 'tests/qa/unit/validation-guards.test.ts',
  name: 'MODEL17/MODEL27: Main requires a reviewed shape and a nonempty focus/graph set' };

export const modelValidationCases: CaseDeclarations = {
  MODEL17: [native, requiredFocus, protectedFootprint, {
    tier: 'model', file: 'model/tests/validation-shape-terms.test.ts',
    name: 'MODEL17: compiler rejects unsupported executable and unreviewed shape terms',
  }],
  MODEL18: [native, work, content],
  MODEL23: [native, work, content],
  MODEL24: [protectedFootprint, {
    tier: 'integration', file: 'tests/qa/integration/validation-product-ingress.test.ts',
    name: 'MODEL24: product Fuseki ingress rejects raw Update and Graph Store writes',
  }],
  MODEL27: [native, requiredFocus, protectedFootprint, {
    tier: 'unit', file: 'tests/qa/unit/validation-guards.test.ts',
    name: 'MODEL27: a deadline without an operation receipt remains unknown',
  }],
};
