import { expect, test } from 'bun:test';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import type { ContentCore } from '../../content/src/core.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { RealmReplyContentStore, RealmReplyUnavailable } from '../src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const ref = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const root = ref(1), rootRevision = ref(2), author = ref(3), parent = ref(4), child = ref(5);
const parentRevision = '00000000-0000-4000-8000-000000000006';
const principal = { issuer: 'account', subject: 'reader', emailVerified: true } as VerifiedPrincipal;
const bind = (value: string) => ({ value });
type ParentState = 'visible' | 'hidden' | 'absent' | 'changed' | 'unavailable';

/** Real listPublic and parent readPublicBatch consume injected Content, graph
 * and disclosure owners. No global module mock replaces an authority decision. */
function fixture(state: ParentState, options: { count?: number; sharedParent?: boolean; noParent?: boolean } = {}) {
  const calls = { list: 0, parentBatches: [] as string[][], parentReads: [] as string[], writes: 0 };
  const count = options.count ?? 1;
  const children = Array.from({ length: count }, (_, index) => ({ reply: count === 1 ? child : ref(100 + index),
    author, originRealm: null, rootTarget: root, rootRevision,
    parentReply: options.noParent ? null : options.sharedParent === false ? ref(200 + index) : parent,
    parentRevision: options.noParent ? null : parentRevision,
    variantId: `urn:rezics:variant:00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    revisionId: `00000000-0000-4000-8000-${(300 + index).toString(16).padStart(12, '0')}`,
    revisionDigest: 'a'.repeat(64), body: `Retained child content ${index}`, spoiler: true }));
  const content = { listCurrent: async (target: string, revision: string, after?: string, realm?: string | null) => {
    calls.list++;
    expect([target, revision, after, realm]).toEqual([root, rootRevision, undefined, null]);
    return { items: structuredClone(children), next: ref(999) };
  }, readCurrent: async (reply: string) => {
    calls.parentReads.push(reply);
    if (state === 'unavailable') throw new RealmReplyUnavailable('Parent Content owner is unavailable');
    if (state === 'absent') return null;
    return { reply, author, originRealm: null, rootTarget: root, rootRevision,
      variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000010',
      revisionId: state === 'changed' ? '00000000-0000-4000-8000-000000000011' : parentRevision,
      revisionDigest: 'b'.repeat(64), body: 'Parent content' };
  } } as unknown as RealmReplyContentStore;
  const env = { objectDirectory: '.temp/reply-parent-disclosure', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sql: string) => {
      if (/\b(?:INSERT|DELETE)\s*\{/i.test(sql)) { calls.writes++; throw new Error('Read attempted a graph write'); }
      if (/\bASK\s*\{/i.test(sql)) return { boolean: true };
      let rows: Record<string, { value: string; 'xml:lang'?: string }>[];
      if (sql.includes('AS ?hasCurrentIdentity')) {
        rows = [{ epoch: bind('epoch'), sequence: bind('9'), r: bind(root), hasCurrentIdentity: bind('true'),
          type: bind('work'), work: bind(root), head: bind(rootRevision), public: bind('true'),
          erased: bind('false'), label: { value: 'Discussion target', 'xml:lang': 'en' } }];
      } else if (sql.includes('SELECT ?epoch ?sequence ?r ?revision')) {
        rows = [{ epoch: bind('epoch'), sequence: bind('9'), r: bind(root), revision: bind(rootRevision),
          type: bind('https://schema.org/CreativeWork') }];
      } else if (sql.includes('SELECT ?root WHERE')) rows = [{ root: bind(rootRevision) }];
      else if (sql.includes('SELECT ?resource ?head')) rows = [{ resource: bind(root), head: bind(rootRevision) }];
      else if (sql.includes('SELECT ?work ?head ?owningWork ?owningHead')) rows = [{ work: bind(root), head: bind(rootRevision) }];
      else if (sql.includes('rv:RestoreCutover')) rows = [];
      else if (sql.includes(`GRAPH <${GRAPHS.control}>`)) rows = [{ epoch: bind('epoch'), sequence: bind('9') }];
      else throw new Error(`Unexpected graph owner read: ${sql}`);
      return { results: { bindings: rows } };
    } },
  } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(env, target => target.work ? { resource: root, head: rootRevision,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  configureDisclosure(env, fixtureDisclosureReader(async (targets) => targets.map(target =>
    state === 'hidden' && target.owner === 'content' && !children.some(item => item.reply === target.resource)
      ? 'hidden' : 'visible')));
  const access = { canReadWork: async () => true } as unknown as ConstructorParameters<typeof RealmReplyStore>[2];
  const store = new RealmReplyStore(content, { settlePublication: async () => {
    calls.writes++; throw new Error('Read attempted Content settlement');
  } } as Pick<ContentCore, 'settlePublication'>, access, env);
  const parentBatch = store.readPublicBatch;
  store.readPublicBatch = async function (replies, verified, actor) {
    calls.parentBatches.push([...replies]);
    expect(verified).toBe(principal);
    expect(actor).toBe(author);
    return parentBatch.call(this, replies, verified, actor);
  };
  return { store, calls, children, read: () => store.listPublic(root, rootRevision, undefined, undefined, principal, author) };
}

test('a hidden immediate parent and a parent that never existed yield the same complete list body', async () => {
  const hidden = fixture('hidden'), absent = fixture('absent');
  const hiddenPage = await hidden.read(), absentPage = await absent.read();
  expect(hiddenPage).toEqual(absentPage);
  expect(hiddenPage).toEqual({ items: [{ ...hidden.children[0], parentReply: null, parentRevision: null }], next: ref(999) });
  expect(hidden.calls.parentBatches).toEqual([[parent]]);
  expect(absent.calls.parentBatches).toEqual([[parent]]);
  expect(hidden.calls.writes + absent.calls.writes).toBe(0);
});

test('a list item with no parent already has the same null coordinates and requires no parent body read', async () => {
  const f = fixture('visible', { noParent: true });
  expect(await f.read()).toEqual({ items: f.children, next: ref(999) });
  expect(f.calls.parentBatches).toEqual([]);
  expect(f.calls.parentReads).toEqual([]);
  expect(f.calls.writes).toBe(0);
});

test('the exact authorized parent retains both coordinates without changing child content or pagination', async () => {
  const f = fixture('visible');
  expect(await f.read()).toEqual({ items: f.children, next: ref(999) });
  expect(f.calls.parentReads).toEqual([parent]);
  expect(f.calls.writes).toBe(0);
});

test('a visible newer parent cannot disclose the retained parent revision', async () => {
  const f = fixture('changed');
  expect(await f.read()).toEqual({ items: [{ ...f.children[0], parentReply: null, parentRevision: null }], next: ref(999) });
});

test('a parent owner outage fails the list instead of being presented as no parent', async () => {
  const f = fixture('unavailable');
  await expect(f.read()).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect(f.calls.writes).toBe(0);
});

test('one page authorizes at most 32 immediate parents in one deduplicated batch with no ancestor reads', async () => {
  const distinct = fixture('visible', { count: 32, sharedParent: false });
  expect((await distinct.read())?.items).toHaveLength(32);
  expect(distinct.calls.parentBatches).toHaveLength(1);
  expect(distinct.calls.parentBatches[0]).toHaveLength(32);
  expect(distinct.calls.parentReads).toEqual(distinct.children.map(item => item.parentReply!));
  expect(distinct.calls.writes).toBe(0);
  const shared = fixture('visible', { count: 32, sharedParent: true });
  expect((await shared.read())?.items).toHaveLength(32);
  expect(shared.calls.parentBatches).toEqual([[parent]]);
  expect(shared.calls.parentReads).toEqual([parent]);
  expect(shared.calls.writes).toBe(0);
});

test('an oversized owner page fails closed before any parent batch', async () => {
  const f = fixture('visible', { count: 33, sharedParent: false });
  await expect(f.read()).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect(f.calls.parentBatches).toEqual([]);
  expect(f.calls.writes).toBe(0);
});
