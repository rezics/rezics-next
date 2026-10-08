/** Inventory guards read files beyond their import graph, so affected selection
 * cannot establish their coverage. Merge runs these in its existing unit gate.
 * Owner-specific assertions and migration setup for database fixtures stay in
 * their normal affected tiers; these entries enforce an inventory-wide rule. */
export const repositoryGuards = [
  {
    file: 'tests/qa/unit/g-1046-sql-relations.test.ts',
    reason: 'Every SQL source relation must exist in the complete migrated relation inventory.',
  },
  {
    file: 'services/main/tests/platform-exposure.test.ts',
    reason: 'Every installed Main route must declare its platform exposure.',
  },
  {
    file: 'scripts/static/list-convention.test.ts',
    reason: 'Every public OpenAPI list operation must meet the list convention without new debt.',
  },
  {
    file: 'tests/qa/unit/test-registry.test.ts',
    reason: 'Every tracked Bun test must belong to a QA tier or a reasoned exclusion.',
  },
  {
    file: 'services/main/tests/g-543-rate-limit.test.ts',
    reason: 'Every installed Main route and generated operation must have a rate-limit family.',
  },
  {
    file: 'tests/qa/unit/migration-numbers.test.ts',
    reason: 'Every owner migration directory must number its files uniquely.',
  },
  {
    file: 'scripts/lib/g-940-migration-order.test.ts',
    reason: 'All owner migration inventories must retain numeric order and complete versions.',
  },
  {
    file: 'scripts/qa/schema-order-audit.test.ts',
    reason: 'All migration readers in scripts, services and tests must use numeric ordering.',
  },
  {
    file: 'tests/qa/unit/serialization-points.test.ts',
    reason:
      'All service migrations and write sources must avoid unapproved serialization and gate upgrades.',
  },
  {
    file: 'scripts/static/anti-silo.test.ts',
    reason:
      'All migrations and shared Main/web source trees must stay within the anti-silo baseline.',
  },
  {
    file: 'tests/qa/unit/outbox-event-handlers.test.ts',
    reason: 'Every statically emitted Main outbox event kind must have a relay reader.',
  },
  {
    file: 'services/main/tests/g-896-content-sequence.test.ts',
    reason:
      'All service source files must leave Content event numbering and appends to the sequencer.',
  },
  {
    file: 'services/main/tests/g-829-public-reads.test.ts',
    reason:
      'The complete resource, composition, Collection and lexicon GET inventory must declare disclosure.',
  },
  {
    file: 'services/main/tests/g-656-vertical-facts.test.ts',
    reason: 'The full served Main operation inventory must contain no vertical facts operations.',
  },
  {
    file: 'services/main/tests/api-contract.test.ts',
    reason:
      'Every generated public operation must retain versioned paths and declared success/problem responses.',
  },
  {
    file: 'tests/qa/unit/openapi-tuples.test.ts',
    reason:
      'Every schema in the generated public contract must use JSON Schema 2020-12 tuple keywords.',
  },
  {
    file: 'tests/qa/unit/backend-operation-map.test.ts',
    reason:
      'The complete frozen backend case inventory must map existing operations to the public contract.',
  },
  {
    file: 'services/main/tests/g-845-protocol.test.ts',
    reason:
      'Every standalone wiki protocol source must retain licensing and avoid product/runtime dependencies.',
  },
  {
    file: 'packages/wiki-toolkit/tests/package.test.ts',
    reason:
      'Every wiki toolkit source import must stay local or declared and avoid networking/runtime dependencies.',
  },
  {
    file: 'tests/qa/unit/app-error-hook.test.ts',
    reason:
      'Route modules mounted by createMainApp must not declare a local error hook the app hook would hide.',
  },
] as const;
