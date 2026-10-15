import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { testArgs, isQaIntegrationPath } from '../../../scripts/qa/acceptance.ts';
import { expandTestPaths } from '../../../scripts/qa/core.ts';
import { configureDisclosure, type DisclosureTarget } from '../../../services/main/src/modules/disclosure/read.ts';
import { readRealmDirectory, type RealmDirectorySort } from '../../../services/main/src/modules/realm-directory/read.ts';
import { resourceDisclosureTarget } from '../../../services/main/src/modules/query/resources.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import type { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import type { PublicProfile } from '../../../services/main/src/modules/realm-profile/schema.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const closed = id(1), live = id(2);
const value = (text: string) => ({ value: text });

function fixture() {
  const state = { closingDuringHydration: false, hydrated: [] as string[], targets: [] as DisclosureTarget[][],
    closedVisible: false, after: false, publicSpace: true, hiddenName: false,
    profile: null as PublicProfile | null };
  const environment = { fuseki: {} } as WorkActivationEnvironment;
  configureDisclosure(environment, { read: async () => [] });
  const session = { options: {}, displayLanguages: ['en'], position: { dataEpoch: 'epoch', sequence: '9' },
    deps: { environment, access: { realmDirectory: {
      page: async () => ({ rows: (state.after ? [live] : [closed]).map(realm => ({
        realm, space: id(realm === closed ? 11 : 12), profile: state.profile, rank: '-9', count_value: '0', count_revision: '0',
      })), next: state.after ? null : 'opaque-source-continuation', position: 'directory-position',
        sourcePosition: { dataEpoch: 'epoch', sequence: '8' } }),
      fence: async () => {},
    } } },
    query: async () => (state.after ? [live] : [closed]).map(realm => ({ realm: value(realm),
      space: value(id(realm === closed ? 11 : 12)), head: value(id(20)),
      disclosure: value(`https://rezics.com/vocab/${state.publicSpace ? 'Public' : 'Private'}`) })),
    disclosure: async (targets: DisclosureTarget[]) => {
      state.targets.push(targets);
      return targets.map(target => target.resource === closed && !state.closedVisible
        || target.component === 'name' && state.hiddenName ? 'hidden' : 'visible');
    },
    summaries: async (realms: string[]) => {
      state.hydrated.push(...realms);
      if (state.closingDuringHydration) state.closedVisible = false;
      return realms.map(reference => ({ reference, type: 'realm', status: 'available', disclosure: 'public',
        name: { value: 'Outcome Realm', language: 'en', direction: 'ltr', basis: 'original' },
        avatar: { kind: 'fallback' } }));
    },
  } as unknown as WorkReadSession;
  return { session, state };
}

for (const sort of ['activity', 'members', 'newest', 'growing'] as RealmDirectorySort[]) {
  for (const q of [undefined, 'Outcome']) {
    test(`Realm directory omits closed ${sort} q=${q ?? ''} candidates and continues to live rows`, async () => {
      const { session, state } = fixture();
      const first = await readRealmDirectory(session, { sort, q });
      expect(first.items).toEqual([]);
      expect(first.count.value).toBe(0);
      expect(first.nextCursor).toBe('opaque-source-continuation');
      expect(state.hydrated).toEqual([]);
      state.after = true;
      session.options.cursor = first.nextCursor!;
      const second = await readRealmDirectory(session, { sort, q });
      expect(second.items.map(item => item.id)).toEqual([live]);
      expect(second.nextCursor).toBeNull();
      expect(state.targets.flat().every(target => target.component === 'record')).toBe(true);
    });
  }
}

test('Realm directory drops a record closed during summary hydration', async () => {
  const { session, state } = fixture();
  state.closedVisible = true;
  state.closingDuringHydration = true;
  const page = await readRealmDirectory(session, { sort: 'newest' });
  expect(state.hydrated).toEqual([closed]);
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBe('opaque-source-continuation');
});

test('resource-list successor gates Realm records while retaining independent Work name heads', () => {
  expect(resourceDisclosureTarget({ id: closed, kind: 'realm', head: id(20) }))
    .toEqual({ owner: 'graph', resource: closed, component: 'record', nameOwnerResolved: true });
  expect(resourceDisclosureTarget({ id: live, kind: 'work', head: id(21) }))
    .toEqual({ owner: 'graph', resource: live, component: 'name', nameOwnerResolved: true,
      work: live, workRevision: id(21), revision: id(21) });
});

for (const hiddenName of [false, true]) {
  test(`published directory text uses its snapshot with current name disclosure hidden=${hiddenName}`, async () => {
    const { session, state } = fixture();
    state.after = true;
    state.hiddenName = hiddenName;
    state.profile = { name: { original: 'en', labels: { en: 'Published name' } },
      description: { original: 'en', labels: { en: 'Published description' } },
      iconSelection: null, bannerSelection: null, count: { kind: 'unknown', value: null }, moderators: [] };
    const page = await readRealmDirectory(session, { sort: 'newest' });
    expect(state.hydrated).toEqual([]);
    expect(state.targets.flat()).toContainEqual({ owner: 'graph', resource: live, component: 'name',
      revision: id(20), nameOwnerResolved: true });
    expect(page.items.map(item => item.name.value)).toEqual(hiddenName ? [] : ['Published name']);
  });
}

test('closure search and directory outcomes are included in the recursive integration tier', () => {
  const root = resolve(import.meta.dir, '../../..');
  const files = expandTestPaths(root, testArgs('integration', undefined, undefined, root));
  for (const row of ['closure-search', 'closure-directory']) {
    const file = `tests/qa/integration/outcomes/realm/${row}.test.ts`;
    expect(isQaIntegrationPath(file)).toBe(true);
    expect(files).toContain(file);
  }
});
