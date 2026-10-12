import { expect, test } from 'bun:test';
import { admittedPage } from '../src/modules/disclosure/admitted-page.ts';
import { WorkReadSession, WorkReadMoved, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

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
