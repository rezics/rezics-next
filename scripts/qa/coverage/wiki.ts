import type { CaseDeclarations } from './declaration.ts';

const zone = { tier: 'integration' as const, file: 'tests/qa/integration/zone-wiki.test.ts',
  name: 'WIKI01/WIKI02/VIEW03/VIEW06/CTX01: two Zones mount one Collection without owning or disclosing it' };
const collection = { tier: 'integration' as const, file: 'tests/qa/integration/collection-wiki.test.ts',
  name: 'WIKI03/WIKI06/CTX08: a Collection keeps repeated occurrence history and hides private members' };
const dynamic = { tier: 'integration' as const,
  file: 'tests/qa/integration/collection-dynamic-wiki.test.ts',
  name: 'WIKI04/VIEW05: saved dynamic query and captured Collection retain separate exact state' };
const nested = { tier: 'integration' as const,
  file: 'tests/qa/integration/collection-dynamic-wiki.test.ts',
  name: 'VIEW05: a nested query cannot renew the shared time ceiling' };
const recovery = { tier: 'fault/recovery' as const,
  file: 'tests/qa/fault-recovery/zone-wiki.test.ts',
  name: 'WIKI02/VIEW06: Zone owner bootstrap and configuration recover exact lost graph responses' };
const realmText = { tier: 'integration' as const,
  file: 'tests/qa/integration/wiki-realm-selection.test.ts',
  name: 'WIKI05: Realm serving text and search keep its accepted draft while the source edits' };
const realmMedia = { tier: 'integration' as const,
  file: 'tests/qa/integration/wiki-realm-selection.test.ts',
  name: 'WIKI05: Realm media serves its accepted exact set after the source publishes a newer set' };

export const wikiCases: CaseDeclarations = {
  WIKI01: [zone],
  WIKI02: [zone, recovery],
  WIKI03: [collection],
  WIKI04: [dynamic],
  WIKI05: [realmText, realmMedia],
  WIKI06: [collection],
  VIEW03: [zone],
  VIEW05: [dynamic, nested],
  VIEW06: [zone, recovery],
};
