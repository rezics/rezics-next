import { Value } from 'typebox/value';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable, type ReadRow } from '../src/modules/work/read-session.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { discussionItem } from '../src/modules/work-activity/read-contract.ts';
import { readWorkDiscussion, workDiscussionText } from '../src/modules/work-activity/read.ts';

const identity = {
  reply: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  placement: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  kind: 'reply',
  revisionId: '00000000-0000-4000-8000-000000000004', dataEpoch: 'epoch', sequence: '1',
};

test('Work discussion preserves the authored spoiler declaration in its optional wire field', () => {
  const marked = { ...identity, ...workDiscussionText({ body: 'Marked reply', spoiler: true }) };
  expect(marked).toEqual({ ...identity, body: 'Marked reply', spoiler: true });
  expect(Value.Check(discussionItem, marked)).toBe(true);

  const explicitlyUnmarked = { ...identity, ...workDiscussionText({ body: 'Visible reply', spoiler: false }) };
  expect(explicitlyUnmarked.spoiler).toBe(false);
  expect(Value.Check(discussionItem, explicitlyUnmarked)).toBe(true);

  const legacyUnmarked = { ...identity, ...workDiscussionText({ body: 'Visible reply' }) };
  expect('spoiler' in legacyUnmarked).toBe(false);
  expect(Value.Check(discussionItem, legacyUnmarked)).toBe(true);
  expect(() => workDiscussionText({ body: 'Invalid declaration', spoiler: 'true' }))
    .toThrow('Reply spoiler declaration is invalid');
});

const ref = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const work = ref(10), rootRevision = ref(11), realm = ref(12), author = ref(13), hiddenParent = ref(14);
const bind = (value: string) => ({ type: /^(https:|urn:)/.test(value) ? 'uri' : 'literal', value });

/** Exercise the real reader, target/disclosure fences and immutable identity
 * SQL owner with bounded storage doubles; no thread or ancestor hydration. */
function discussionFixture(size = 3) {
  const identities = Array.from({ length: size }, (_, n) => ({ reply: ref(100 + n),
    parent: n === 0 ? null : n === 1 ? ref(100) : hiddenParent, author, origin: realm,
    root_target: work, root_revision: rootRevision, created_at: new Date('2026-10-19') }));
  const rows: ReadRow[] = identities.map((node, n) => ({ id: bind(ref(200 + n)), reply: bind(node.reply),
    realm: bind(realm), revision: bind(`urn:rezics:content:revision:${ref(300 + n).slice(-36)}`),
    review: bind(`urn:rezics:realm-review:${ref(400 + n).slice(-36)}`),
    rootRevision: bind(rootRevision), ...(node.parent ? { parent: bind(node.parent) } : {}),
    revisionEpoch: bind('epoch'), epochOrder: bind('0'), sequence: bind(String(size - n)) }));
  const calls = { identities: [] as string[][], bodies: [] as string[][], target: 0,
    visible: new Map<string, number>() };
  const state = { identities, rows, hidden: new Set<string>(), hiddenAtClose: new Set<string>(),
    identityUnavailable: false, hideWorkAtClose: false };
  const content = { query: async (sql: string, params: string[][]) => {
    expect(sql).toContain('FROM content.reply WHERE id=ANY($1::text[])');
    expect(sql).toContain('parent_reply AS parent');
    expect(params[0]!.length).toBeLessThanOrEqual(20);
    calls.identities.push([...params[0]!]);
    if (state.identityUnavailable) throw new Error('Content connection lost');
    return { rows: state.identities.filter(node => params[0]!.includes(node.reply)) };
  } } as unknown as Pool;
  const deps = {
    access: { assertRecoveryOpen: async () => {} },
    realmReplyThreads: new RealmReplyThreadStore(content, {} as Pool),
    realmReplies: { visible: async (selectedRealm: string, reply: string) => {
      const key = `${selectedRealm}:${reply}`, count = (calls.visible.get(key) ?? 0) + 1;
      calls.visible.set(key, count);
      const row = state.rows.find(row => row.reply!.value === reply && row.realm!.value === selectedRealm);
      if (!row || state.hidden.has(reply) || count > 1 && state.hiddenAtClose.has(reply)) return null;
      return { placement: row.id!.value, revisionId: row.revision!.value.slice(-36),
        reviewDecisionId: row.review!.value.slice(-36) };
    } },
    content: { readExactBatch: async (ids: string[]) => {
      calls.bodies.push([...ids]);
      return ids.map(revisionId => ({ status: 'available', revisionId, body: { body: 'The same authored text' },
        reference: { resourceId: state.rows.find(row => row.revision!.value.endsWith(revisionId))!.reply!.value } }));
    } },
    environment: { objectDirectory: '.temp/work-discussion-unit',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query: async (sql: string) => {
        let bindings: ReadRow[];
        if (sql.includes('SELECT ?id ?reply ?realm ?revision')) {
          expect(sql).toContain('rv:parentReply ?parent');
          expect(sql).toContain('rv:rootRevision ?rootRevision');
          expect(sql).toContain(`rv:rootTarget <${work}>`);
          bindings = state.rows.slice(0, Number(/LIMIT (\d+)\s*$/.exec(sql)![1]));
        } else if (sql.includes('AS ?hasCurrentIdentity')) {
          calls.target++;
          bindings = [{ epoch: bind('epoch'), sequence: bind('30'), r: bind(work),
            hasCurrentIdentity: bind('true'), type: bind('work'), work: bind(work), head: bind(rootRevision),
            public: bind('true'), erased: bind('false'), label: { ...bind('A Work'), 'xml:lang': 'en' } }];
        } else if (sql.includes('SELECT ?epoch ?sequence ?r ?revision')) {
          bindings = [{ epoch: bind('epoch'), sequence: bind('30'), r: bind(work), revision: bind(rootRevision),
            type: bind('https://schema.org/CreativeWork') }];
        } else if (sql.includes('SELECT ?resource ?head')) {
          bindings = [{ resource: bind(work), head: bind(rootRevision) }];
        } else if (sql.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
          bindings = [{ work: bind(work), head: bind(rootRevision) }];
        } else if (sql.includes('rv:RestoreCutover')) bindings = [];
        else if (sql.includes(`GRAPH <${GRAPHS.control}>`)) bindings = [{ epoch: bind('epoch'), sequence: bind('30') }];
        else throw new Error(`Unexpected graph query: ${sql}`);
        return { results: { bindings } };
      } },
    },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: target.work, head: rootRevision, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(target =>
    target.resource === work && state.hideWorkAtClose && calls.target > 1 ? 'hidden' : 'visible')));
  const session = new WorkReadSession(deps,
    new Request(`http://main.test/v1/resources/${work.slice(-36)}/discussion`), {},
    { dataEpoch: 'epoch', sequence: '30' });
  return { state, calls, deps, session, read: () => readWorkDiscussion(session, work) };
}

test('Work discussion distinguishes the native post and replies without disclosing a hidden parent', async () => {
  const f = discussionFixture();
  const page = await f.read();
  expect(page.items.map(item => item.kind)).toEqual(['post', 'reply', 'reply']);
  expect(page.items.every(item => Value.Check(discussionItem, item))).toBe(true);
  expect(page.items.every(item => item.body === 'The same authored text')).toBe(true);
  expect(f.calls.identities).toEqual([f.state.identities.map(node => node.reply)]);
  expect(f.calls.bodies).toHaveLength(1);
  expect(JSON.stringify(page)).not.toContain(hiddenParent);
  expect(JSON.stringify(page)).not.toContain(author);
  expect(page.items.every(item => !('parent' in item) && !('rootRevision' in item))).toBe(true);
  expect(f.calls.target).toBe(2);
});

test('Work discussion reads at most twenty selected identities and leaves the cursor sentinel unhydrated', async () => {
  const f = discussionFixture(21);
  const page = await f.read();
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeString();
  expect(f.calls.identities).toEqual([f.state.identities.slice(0, 20).map(node => node.reply)]);
  expect(f.calls.bodies[0]).toHaveLength(20);
});

test('Work discussion shares one immutable identity across independent visible Realm placements', async () => {
  const f = discussionFixture(1), row = f.state.rows[0]!;
  f.state.rows.push({ ...row, id: bind(ref(500)), realm: bind(ref(501)) });
  const page = await f.read();
  expect(page.items.map(item => item.kind)).toEqual(['post', 'post']);
  expect(page.items.map(item => item.realm)).toEqual([realm, ref(501)]);
  expect(f.calls.identities).toEqual([[row.reply!.value]]);
  expect(f.calls.bodies).toEqual([[row.revision!.value.slice(-36)]]);
});

for (const mismatch of ['missing', 'duplicate', 'parent', 'root', 'root-revision', 'native-parent',
  'native-root-revision', 'missing-native-root', 'invalid-parent'] as const) {
  test(`Work discussion refuses ${mismatch} identity instead of guessing a post`, async () => {
    const f = discussionFixture(2), child = f.state.identities[1]!, row = f.state.rows[1]!;
    if (mismatch === 'missing') f.state.identities.pop();
    if (mismatch === 'duplicate') f.state.identities.push({ ...child });
    if (mismatch === 'parent') child.parent = null;
    if (mismatch === 'root') child.root_target = ref(600);
    if (mismatch === 'root-revision') child.root_revision = ref(601);
    if (mismatch === 'native-parent') row.parent = bind(ref(602));
    if (mismatch === 'native-root-revision') row.rootRevision = bind(ref(603));
    if (mismatch === 'missing-native-root') delete row.rootRevision;
    if (mismatch === 'invalid-parent') { child.parent = 'unowned-parent'; row.parent = bind(child.parent); }
    await expect(f.read()).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
}

test('Work discussion refuses an absent or unavailable identity owner', async () => {
  const absent = discussionFixture();
  delete absent.deps.realmReplyThreads;
  await expect(absent.read()).rejects.toBeInstanceOf(WorkReadUnavailable);
  const unavailable = discussionFixture();
  unavailable.state.identityUnavailable = true;
  await expect(unavailable.read()).rejects.toThrow('Reply identities are unavailable');
});

test('Work discussion hydrates identities only after visibility and retains its closing review check', async () => {
  const f = discussionFixture();
  f.state.hidden.add(f.state.identities[1]!.reply);
  f.state.hiddenAtClose.add(f.state.identities[2]!.reply);
  const page = await f.read();
  expect(page.items.map(item => item.reply)).toEqual([f.state.identities[0]!.reply]);
  expect(f.calls.identities).toEqual([[f.state.identities[0]!.reply, f.state.identities[2]!.reply]]);
});

test('Work discussion retains the final Work disclosure and exact native placement fences', async () => {
  const hidden = discussionFixture();
  hidden.state.hideWorkAtClose = true;
  await expect(hidden.read()).rejects.toThrow();
  const moved = discussionFixture();
  await moved.read();
  moved.state.rows[1]!.parent = bind(hiddenParent);
  await expect(moved.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});
