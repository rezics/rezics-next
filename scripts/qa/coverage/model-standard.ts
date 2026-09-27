import type { CaseDeclarations } from './declaration.ts';

const statement = { tier: 'integration', file: 'tests/qa/integration/context-statement-cases.test.ts',
  name: 'CTX01/MODEL13: shared Context selection preserves distinct Realm and personal Statement meanings' } as const;

export const modelStandardCases: CaseDeclarations = {
  MODEL13: [
    statement,
    { tier: 'integration', file: 'tests/qa/integration/model-standard-annotation.test.ts',
      name: 'MODEL13: Annotation through the Content comment API retains OA type, target, selector and local revision evidence' },
    { tier: 'integration', file: 'tests/qa/integration/model-standard-label.test.ts',
      name: 'MODEL13: Label as scoped SKOS labels retain lexical value, language and exact Context qualifiers' },
    { tier: 'unit', file: 'services/main/tests/structure-listitem.test.ts',
      name: 'MODEL13: ListItem read accepts schema:item and retained rv:target data' },
  ],
  CTX01: [
    statement,
    { tier: 'integration', file: 'tests/qa/integration/zone-wiki.test.ts',
      name: 'WIKI01/WIKI02/VIEW03/VIEW06/CTX01: two Zones mount one Collection without owning or disclosing it' },
  ],
  CTX08: [
    { tier: 'integration', file: 'tests/qa/integration/context-advanced-cases.test.ts',
      name: 'CTX08/CTX10: concurrent reparent has one winner; pinned consumers survive bounded head changes' },
    { tier: 'integration', file: 'tests/qa/integration/collection-wiki.test.ts',
      name: 'WIKI03/WIKI06/CTX08: a Collection keeps repeated occurrence history and hides private members' },
  ],
};
