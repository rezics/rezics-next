import { expect, test } from 'bun:test';
import { admittedPage } from '../src/modules/disclosure/admitted-page.ts';
import { WorkReadSession, WorkReadMoved, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { Pool } from 'pg';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureCut } from './support/disclosure-ancestry.ts';
import { readRealmWorks } from '../src/modules/realm-reads/read-works.ts';
import type { ResourceSummary } from '../src/modules/media/summary.ts';

const term = (value: string) => ({ type: 'literal', value });
function fixture() {
  const rows: ReadRow[] = Array.from({ length: 64 }, (_, index) => ({
    work: term(String(index + 1).padStart(3, '0')), head: term(`head-${index}`), visible: term('true'),
  }));
  let recoveryChecks = 0;
  const deps = { environment: { fuseki: { query: async () => ({ results: { bindings: rows.map(row => ({ ...row })) } }) } },
    access: { assertRecoveryOpen: async () => { recoveryChecks++; } } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/realms/works'),
    { limit: 1 }, { dataEpoch: 'epoch', sequence: '7' });
  const select = () => session.selection('realm-works', probe => admittedPage<ReadRow>({
    limit: 1, key: row => row.work!.value,
    fetch: (_after, size) => probe.query('SELECT ?work ?head ?visible WHERE { ?work rv:head ?head }', size),
    admit: async candidates => candidates.filter(row => row.visible!.value === 'true'),
  }), value => ({ page: value.page, hasMore: !!value.lookahead }));
  return { rows, session, select, recoveryChecks: () => recoveryChecks };
}

test('admission of 64 candidates fences the shown row and continuation presence, not unshown heads', async () => {
  const f = fixture();
  const page = await f.select();
  expect(page.page.map(row => row.work!.value)).toEqual(['001']);
  f.rows[2]!.head = term('edited-unshown-third-work');
  f.rows[1]!.head = term('edited-lookahead-work');
  await f.session.fenceDependencies();
  expect(f.recoveryChecks()).toBe(2);
});

for (const change of ['shown head', 'shown visibility', 'earlier membership', 'continuation presence'] as const) {
  test(`admission selected-result fence detects changed ${change}`, async () => {
    const f = fixture();
    await f.select();
    if (change === 'shown head') f.rows[0]!.head = term('new-shown-head');
    if (change === 'shown visibility') f.rows[0]!.visible = term('false');
    if (change === 'earlier membership') f.rows.unshift({ work: term('000'), head: term('new-head'), visible: term('true') });
    if (change === 'continuation presence') f.rows.splice(1);
    // Keep the graph stub's bounded response equal to the owner SELECT LIMIT.
    if (f.rows.length > 64) f.rows.length = 64;
    await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  });
}

test('ordinary exact query rows still fence every returned selected head', async () => {
  const f = fixture();
  await f.session.query('SELECT ?work ?head WHERE { VALUES ?work { "003" } }', 64);
  f.rows[2]!.head = term('new-selected-head');
  await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

const nativeId = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function realmFixture() {
  const f = fixture();
  f.session.deps.environment.lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  for (const row of f.rows) Object.assign(row, {
    main: term(`main-${row.work!.value}`), selection: term(`selection-${row.work!.value}`),
    contribution: term(`contribution-${row.work!.value}`), language: term('en'),
  });
  f.rows.forEach((row, index) => ['work', 'head', 'main', 'selection', 'contribution']
    .forEach((key, owner) => { row[key] = term(nativeId((owner + 1) * 1000 + index)); }));
  f.session.deps.environment.fuseki.query = async body => ({ results: { bindings:
    body.includes('SELECT DISTINCT ?work ?head ?main') ? f.rows.map(row => ({ ...row }))
      : body.includes('SELECT ?resource ?head') ? f.rows.filter(row => body.includes(`<${row.work!.value}>`))
        .map(row => ({ resource: row.work!, head: row.head! }))
      : body.includes('SELECT ?work ?head ?nameOwner') || body.includes('SELECT ?work ?head ?owningWork')
        ? f.rows.filter(row => body.includes(`<${row.work!.value}>`))
          .map(row => ({ work: row.work!, head: row.head! }))
        : body.includes('SELECT ?work ?head') ? f.rows.filter(row => body.includes(`<${row.work!.value}>`))
          .map(row => ({ work: row.work! })) : [] } });
  const pool = { query: async (sql: string, args?: unknown[]) => ({ rows: sql.includes('jsonb_to_recordset')
    ? (JSON.parse(String(args![0])) as Array<{ ordinal: number }>).map(target => ({
      open: true, ordinal: target.ordinal, restricted: false, assessments: [],
      realmClosed: false, ...fixtureDisclosureCut,
    })) : [] }) } as unknown as Pool;
  configureDisclosure(f.session.deps.environment, new DisclosureStore(pool));
  configureFixtureDisclosureAncestry(f.session.deps.environment, target => target.work
    ? { resource: target.work, head: f.rows.find(row => row.work!.value === target.work)!.head!.value,
      protectedRevision: target.workRevision } : undefined);
  f.session.realm = async realm => ({ realmRevision: 'realm-head', space: realm, visibility: 'public',
    reviewMode: 'open', revision: null }) as never;
  f.session.summaries = async resources => resources.map(reference => ({ reference, status: 'available',
    type: 'work', disclosure: 'public', name: { value: reference }, avatar: { kind: 'fallback' },
  }) as ResourceSummary);
  return f;
}

test('Realm Work reader excludes unshown candidate and lookahead heads from its delivery fence', async () => {
  const f = realmFixture();
  const page = await readRealmWorks(f.session, nativeId(9000));
  expect(page.items.map(item => item.id)).toEqual([nativeId(1000)]);
  expect(page.nextCursor).not.toBeNull();
  f.rows[2]!.head = term(nativeId(12000));
  f.rows[1]!.head = term(nativeId(12001));
  await f.session.fenceDependencies();
});

for (const change of ['shown head', 'earlier member', 'continuation'] as const) {
  test(`Realm Work reader fences its selected ${change}`, async () => {
    const f = realmFixture();
    await readRealmWorks(f.session, nativeId(9000));
    if (change === 'shown head') f.rows[0]!.head = term(nativeId(12002));
    if (change === 'earlier member') {
      f.rows.unshift({ ...f.rows[0], work: term(nativeId(999)) });
      f.rows.length = 64;
    }
    if (change === 'continuation') f.rows.splice(1);
    await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  });
}
