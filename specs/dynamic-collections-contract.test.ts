import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const specification = await readFile(new URL('../docs/dynamic-collections.md', import.meta.url), 'utf8');
const outcomes = await readFile(new URL('./dynamic-collections-outcomes.test.ts', import.meta.url), 'utf8');
const driver = await readFile(new URL('./dynamic-collections-driver.ts', import.meta.url), 'utf8');
const filteredLists = await readFile(new URL('../docs/filtered-lists.md', import.meta.url), 'utf8');

test('dynamic Collection work remains specification-only and starts with built-ins', () => {
  expect(specification).toContain('specification-only');
  expect(specification).toContain('The first implementation scope is built-in dynamic Collections');
  expect(specification).toContain('no runtime route, schema, worker, definition, local query engine');
  expect(specification).toContain('Everything, one stable Collection identity for every account');
  expect(specification).toContain('One state Collection per state identity');
});

test('Everything presence reconciles optional state, independent labels, sessions, holdings, and clear state', () => {
  const everything = specification.slice(
    specification.indexOf('`Everything` contains'),
    specification.indexOf('### Profile keys'),
  );
  for (const term of [
    'non-null optional entry state',
    'independent labels',
    'retained progress session/history record',
    'retained holding',
    'Clearing a state',
    'No additional presence flag',
  ])
    expect(everything).toContain(term);
  expect(everything).toContain(
    'follow, curated Collection occurrence, catalogue fact, rating, or published-log snapshot alone',
  );
});

test('profile state identity is registry-scoped and independent of labels or a global enum', () => {
  const profiles = specification.slice(
    specification.indexOf('### Profile keys'),
    specification.indexOf('## One Collection page'),
  );
  expect(profiles).toContain('accepted `type.profileId` reference');
  expect(profiles).toContain('`(profileId, stateSetId, stateId)`');
  expect(profiles).toContain('Localized labels are presentation only');
  expect(profiles).toContain('A retired profile is not rebound');
  expect(profiles).toContain('state Collections keep their old pin and identity');
});

test('one page distinguishes curated occurrences from unique dynamic subjects without fake occurrences', () => {
  const page = specification.slice(
    specification.indexOf('## One Collection page'),
    specification.indexOf('## Access and disclosure'),
  );
  expect(page).toContain('`GET /v1/collections/{collectionId}/members`');
  expect(page).toContain('editor retains all occurrences');
  expect(page).toContain('one row per unique `subjectId`');
  expect(page).toContain('`409 dynamic_membership_immutable`');
  expect(page).toContain('`422 unsupported_query`');
  expect(page).toContain('same Collection ID and shared kernel protocols');
});

test('public dynamic disclosure returns viewer-readable subjects and uses the shared monotonic projection', () => {
  const disclosure = specification.slice(
    specification.indexOf('## Access and disclosure'),
    specification.indexOf('## Saved queries and execution admission'),
  );
  for (const forbidden of [
    'state, label, progress, holding, query body, predicate',
    'private candidate count',
    'private member count',
    "current viewer's native original AND terminal eligibility",
    'Older projection events cannot restore',
  ])
    expect(disclosure).toContain(forbidden);
  expect(disclosure).toContain('Curated listing-freshness defects remain with their current owner');
});

test('saved queries reuse shared grammar and remain later runtime scope with save-time rejection', () => {
  const later = specification.slice(
    specification.indexOf('## Saved queries and execution admission'),
    specification.indexOf('## Query, identity and cursor bounds'),
  );
  expect(later).toContain('First scope exposes built-ins');
  expect(later).toContain('closed catalogue grammar and semantic admission');
  expect(later).toContain('does not create a second catalogue predicate AST');
  expect(later).toContain('Saving validates the full filter + source + order');
  expect(later).toContain('unsupported execution rejects 422 before enumeration');
  expect(later).toContain('execution remains disabled until reviewed native admission');
  expect(outcomes).not.toMatch(/test\s*\(\s*['"].*saved.query.*runtime/i);
  expect(driver).not.toMatch(/saveQuery|executeUserQuery/);
});

test('cursor, candidate, deletion, and native growth bounds are explicit', () => {
  const bound = specification.slice(
    specification.indexOf('## Query, identity and cursor bounds'),
    specification.indexOf('## Acceptance outcomes'),
  );
  expect(bound).toContain('Success fills the requested page or proves a genuinely exhausted final page');
  expect(bound).toContain('return explicit preparation/readiness and retain settled work');
  expect(bound).toContain('existing owner cursor envelope, codec, key ring and binding to viewer');
  expect(bound).toContain('changed basis returns stale_cursor');
  expect(bound).toContain('examined/removed rows, buffers, statements/connections, bytes');
  for (const unit of [
    'min(600, 6s + 3)',
    '16 + 8c',
    '64 + 16c',
    '2s + 2',
    'at most 2 index reads',
    'at most three refill rounds',
    'at most 12 statements',
    '64, 512 and 4,096',
  ])
    expect(filteredLists).toContain(unit);
  expect(outcomes).toContain('countedViolations');
  expect(driver).toContain('allCost: Cost');
  expect(driver).toContain('specification-red behavior ONLY');
  expect(specification).toContain('freezes its last complete published subject set');
  expect(specification).toContain('returns without waiting for projection consumers');
});

test('ordered implementation plan names shared owners and stays within its file and phase limits', () => {
  const plan = specification.slice(
    specification.indexOf('## Ordered implementation plan'),
    specification.indexOf('## Decisions fixed'),
  );
  const phases = [...plan.matchAll(/^\| [1-9]\s+\|/gm)];
  expect(phases).toHaveLength(8);
  expect(phases.length).toBeLessThanOrEqual(8);
  expect(specification).toContain('Each implementation landing slice is capped at eight files');
  for (const owner of [
    'Shared Query/List',
    'Shared listing-freshness',
    'Account deletion',
    'Library bulk',
    'Web owner',
  ])
    expect(plan).toContain(owner);
  expect(plan).toContain('Contracts and imports land before production code');
  expect(plan).toContain('Retire `/library/shelf` client/API/tests after the shared engine is live');
});

test('profile migration and independent labels precede built-in Collections and their runtime', () => {
  const plan = specification.slice(
    specification.indexOf('## Ordered implementation plan'),
    specification.indexOf('## Decisions fixed'),
  );
  const profileIndex = plan.indexOf(
    'Definitions and Library implement the canonical profile registry and explicit default migration',
  );
  const builtinIndex = plan.indexOf('Library Collection owner adds built-in identity/read adapters');
  expect(profileIndex).toBeGreaterThanOrEqual(0);
  expect(builtinIndex).toBeGreaterThan(profileIndex);
  expect(plan.slice(profileIndex, builtinIndex)).toContain('then independent labels');
});

test('the default profile migration preserves legacy state meanings in bounded pages', () => {
  expect(specification).toContain(
    'Existing fixed-key state values map without semantic loss to the canonical compatibility profile',
  );
  expect(specification).toContain('explicit migration in pages of at most `P`');
  expect(specification).toContain('labels never choose or rewrite state identities');
});

test('shared cursor key, anonymous, and account lifetimes are adopted without local policy', async () => {
  const cursor = specification.slice(
    specification.indexOf('Keep the existing owner cursor envelope'),
    specification.indexOf('## Cost'),
  );
  expect(cursor).toContain('GET anonymous tokens remain');
  expect(cursor).toContain('deterministic/timeless');
  expect(cursor).toContain('account tokens keep fifteen-minute lifetime');
  expect(cursor).toContain('codec, key ring');
  expect(cursor).toContain('no schema,');
  expect(cursor).toContain('cursor codec or common DTO change is selected here');
  expect(outcomes).toContain(
    'shared cursor lifetime and key retirement follow the common anonymous and account policy',
  );
  expect(driver).toContain('rotateListCursorKey(): Promise<void>');
});

test('Web shelf uses the actual shared Collection page and never keeps a template fork', () => {
  expect(specification).toContain('Web owner adapts the existing CollectionView surface');
  expect(specification).toContain('Keep both addresses and avoid a template fork');
  expect(specification).toContain('Retire `/library/shelf` client/API/tests after the shared engine is live');
});

test('native growth acceptance measures first and deep pages with hidden candidates at each scale', () => {
  expect(specification).toContain('real API/native first/deep/sparse pages at three geometric scales');
  expect(specification).toContain('no chain of short/empty successful pages over raw nonmatches');
  expect(outcomes).toContain(
    'first and deep native pages stay bounded with sparse catalog filters and hidden candidates at three scales',
  );
  expect(driver).toContain('candidateIds: readonly string[]');
  expect(driver).toContain('allCost: Cost');
});

test('members GET cache fill is a bounded derived exception to domain-read purity', () => {
  const reads = specification.slice(
    specification.indexOf('Built-ins are logical on reads'),
    specification.indexOf('### Logical identity'),
  );
  expect(reads).toContain('list, detail, and logical built-in discovery reads are pure');
  expect(reads).toContain('common members GET is the sole read exception');
  expect(reads).toContain('idempotent cache fill under the existing quotas and budgets');
  expect(reads).toContain('actual viewer, Collection, validated filter and sort, and accepted release/meaning');
  expect(reads).toContain('Only the derived preparation');
  expect(reads).toContain('record and its work intent may be written');
  expect(reads).toContain('preparation is never cached authority');
  expect(driver).not.toContain('GET never enqueues/repairs');
  expect(driver).toContain('Only members GET may idempotently fill the derived');
  expect(driver).toContain('preparation record/work intent for (viewer, Collection, validated filter, sort, accepted release/meaning)');
  expect(driver).toContain('never writes resource headers, user state, domain events,');
  expect(driver).toContain('grants or receipts');
  expect(driver).toContain('Continue GET remains no-work and Zone POST');
  expect(driver).toContain('readPage is unchanged');
});

test('useful pages preserve the closed raw preparing wire and retry the captured members URL before requiring 200', () => {
  const wire = outcomes.slice(outcomes.indexOf('async function preparing('), outcomes.indexOf('function pageGrowth('));
  expect(specification).toContain('closed `application/json` body `{preparing:true}`');
  expect(specification).toContain('client retries the same validated URL and cursor');
  expect(specification).toContain('unavailable work remains 503');
  expect(wire).toContain("expect(response.status).toBe(202)");
  expect(wire).toContain("expect(response.headers.get('content-type')).toBe('application/json')");
  expect(wire).toContain("expect(response.headers.get('retry-after')).toMatch(/^\\d+$/)");
  expect(wire).toContain("expect(response.headers.get('cache-control')).toBe('private, no-store')");
  expect(wire).toContain(`expect(await response.clone().text()).toBe('{"preparing":true}')`);
  expect(wire).toContain('const path = queryPath(collectionId, input)');
  expect(wire.match(/queryPath\(collectionId, input\)/g)).toHaveLength(1);
  expect(wire.match(/driver\.measure\(\(\) => get\(as, path\)\)/g)).toHaveLength(3);
  expect(wire.indexOf('await preparing(measured.value)')).toBeLessThan(wire.indexOf('preparation = await settle()'));
  expect(wire).toContain("else expect(repeated.value.status).toBe(200)");
  expect(wire).toContain('const page = await json<CollectionMembersPage>(measured.value.clone())');
  expect(wire).toContain("if (as === 'owner') expect(measured.value.headers.get('cache-control')).toBe('private, no-store')");
  expect(outcomes).toContain('expect(empty.page).toEqual({ members: [], next: null })');
  expect(outcomes).toContain('expect(first.page.members).toHaveLength(2)');
  expect(outcomes).toContain('expect(final.page.members).toHaveLength(1)');
  expect(outcomes).toContain('expect(final.page.next).toBeNull()');
});

test('cache fill retains separate native cost charges and observable domain idempotence without claiming native proof', () => {
  const useful = outcomes.slice(outcomes.indexOf('async function usefulPage('), outcomes.indexOf('function pageGrowth('));
  expect(useful.match(/pageCost\(measured, input\?\.limit \?\? 100\)/g)).toHaveLength(2);
  expect(useful).toContain('pageCost(repeated, input?.limit ?? 100)');
  expect(useful).toContain('preparation = await settle()');
  expect(useful).toContain('const before = await driver.inspect()');
  expect(useful.match(/expect\(await driver\.inspect\(\)\)\.toEqual\(before\)/g)).toHaveLength(2);
  expect(useful).toContain('expect(measured.outputSlots).toBe(0)');
  expect(useful).toContain('expect(repeated.outputSlots).toBe(0)');
  expect(useful).toContain('} else if (measured.value.status === 503)');
  expect(useful).toContain('application\\/problem\\+json');
  expect(useful).toContain("['dependency_unavailable', 'index_not_ready', 'semantic_not_ready']");
  expect(useful).toContain('expect(readiness).toMatchObject({ status: 503, retryable: true })');
  expect(driver).toContain('No retained-plan native cache-fill fixture is delivered');
  expect(driver).toContain('verifier are not native cache-fill proof');
  expect(driver).toContain('same-basis dedupe/quota');
  expect(driver).toContain('malformed/unauthorized denial before cache write');
  expect(driver).toContain('source/epoch/permission revalidation with its native producer');
  expect(outcomes).toContain("if (!location) throw new Error('Dynamic Collection outcome driver is required')");
  expect(outcomes).not.toMatch(/\btest\.(skip|todo)\s*\(/);
});
