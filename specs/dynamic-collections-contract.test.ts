import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const specification = await readFile(new URL('../docs/dynamic-collections.md', import.meta.url), 'utf8');
const outcomes = await readFile(new URL('./dynamic-collections-outcomes.test.ts', import.meta.url), 'utf8');
const driver = await readFile(new URL('./dynamic-collections-driver.ts', import.meta.url), 'utf8');

test('dynamic Collection work remains specification-only and starts with built-ins', () => {
  expect(specification).toContain('specification-only');
  expect(specification).toContain('The first implementation scope is built-in dynamic Collections');
  expect(specification).toContain('no runtime route, schema, worker, definition, local query engine');
  expect(specification).toContain('Everything, one stable Collection identity for every account');
  expect(specification).toContain('One state Collection per state identity');
});

test('Everything presence reconciles optional state, independent labels, sessions, holdings, and clear state', () => {
  const everything = specification.slice(specification.indexOf('`Everything` contains'), specification.indexOf('### Profile keys'));
  for (const term of ['non-null optional entry state', 'independent labels', 'retained progress session/history record',
    'retained holding', 'Clearing a state', 'No additional presence flag'])
    expect(everything).toContain(term);
  expect(everything).toContain('follow, curated Collection occurrence, catalogue fact, rating, or published-log snapshot alone');
});

test('profile state identity is registry-scoped and independent of labels or a global enum', () => {
  const profiles = specification.slice(specification.indexOf('### Profile keys'), specification.indexOf('## One Collection page'));
  expect(profiles).toContain('accepted `type.profileId` reference');
  expect(profiles).toContain('`(profileId, stateSetId, stateId)`');
  expect(profiles).toContain('Localized labels are presentation only');
  expect(profiles).toContain('A retired profile is not rebound');
  expect(profiles).toContain('state Collections keep their old pin and identity');
});

test('one page distinguishes curated occurrences from unique dynamic subjects without fake occurrences', () => {
  const page = specification.slice(specification.indexOf('## One Collection page'), specification.indexOf('## Access and disclosure'));
  expect(page).toContain('`GET /v1/collections/{collectionId}/members`');
  expect(page).toContain('one row per occurrence');
  expect(page).toContain('one row per unique `subjectId`');
  expect(page).toContain('`409 dynamic_membership_immutable`');
  expect(page).toContain('`422 unsupported_query`');
  expect(page).toContain('same Collection ID and shared kernel protocols');
});

test('public dynamic disclosure returns viewer-readable subjects and uses the shared monotonic projection', () => {
  const disclosure = specification.slice(specification.indexOf('## Access and disclosure'), specification.indexOf('## Saved-query language'));
  for (const forbidden of ['state, label, progress, holding, query body, predicate', 'private candidate count',
    'private member count', 'current viewer\'s native `subject:read` check', 'Older projection events cannot restore'])
    expect(disclosure).toContain(forbidden);
  expect(disclosure).toContain('Curated listing-freshness defects remain with their current owner');
});

test('saved-query grammar and budgets are later runtime scope with save-time rejection', () => {
  const later = specification.slice(specification.indexOf('## Saved-query language'), specification.indexOf('## Query and cursor bounds'));
  expect(later).toContain('First-scope runtime supports only the built-ins above');
  expect(later).toContain('type SavedQuery');
  expect(later).toContain('4,096 canonical UTF-8 bytes');
  expect(later).toContain('nesting depth 8, 32 leaves, and 32 values');
  expect(later).toContain('unsupported or not-ready predicate fails at save time');
  expect(later).toContain('Custom query execution is not enabled');
  expect(outcomes).not.toMatch(/test\s*\(\s*['"].*saved.query.*runtime/i);
  expect(driver).not.toMatch(/saveQuery|executeUserQuery/);
});

test('cursor, candidate, deletion, and native growth bounds are explicit', () => {
  const bound = specification.slice(specification.indexOf('## Query and cursor bounds'), specification.indexOf('## Acceptance outcomes'));
  expect(bound).toContain('`C = 4P` unique subject candidates');
  expect(bound).toContain('`C <= 400`');
  expect(bound).toContain('One shared opaque encrypted cursor binds viewer');
  expect(bound).toContain('A basis change returns `409 stale_cursor`');
  expect(bound).toContain('actual rows examined, PostgreSQL buffers, statements, and the shared cost classifier');
  expect(specification).toContain('freezes its last complete published subject set');
  expect(specification).toContain('returns without waiting for projection consumers');
});

test('ordered implementation plan names shared owners and stays within its line and phase limits', () => {
  const plan = specification.slice(specification.indexOf('## Ordered implementation plan'), specification.indexOf('## Decisions fixed'));
  const phases = [...plan.matchAll(/^\| [1-9] \|/gm)];
  expect(phases.length).toBeLessThanOrEqual(8);
  expect(specification.split('\n')).toHaveLength(225);
  for (const owner of ['Shared Query/List', 'Shared listing-freshness', 'Account deletion', 'Library bulk', 'Web owner'])
    expect(plan).toContain(owner);
  expect(plan).toContain('Contracts and imports land before production code');
  expect(plan).toContain('Retire `/library/shelf` client/API/tests after the shared engine is live');
});
