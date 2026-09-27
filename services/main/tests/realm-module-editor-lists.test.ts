import { expect, test } from 'bun:test';
import { readZoneEditorLists } from '../src/modules/zone-modules/editor-lists.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { WorkReadUnavailable, type WorkReadSession }
  from '../src/modules/work/read-session.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const realm = id('00000000-0000-4000-8000-000000000001');
const zone = id('00000000-0000-4000-8000-000000000002');
const collection = id('00000000-0000-4000-8000-000000000003');
const work = id('00000000-0000-4000-8000-000000000004');
const presentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'editors',
  type: 'editorial-list', title: 'Editors', source: { kind: 'collection', collection } }] };
const zoneRead = async () => ({ zone, realm, revision: zone, presentation }) as never;
const publicationRead = async () => ({ zone, realm, revision: zone, presentation,
  configuration: { presentation } }) as never;
const moduleRead = async () => [{ id: 'editors', sources: [{
  source: { kind: 'collection', collection }, state: 'partial',
  members: [{ work }] }] }] as never;

test('editor lists keep the Collection partial state and public Work titles', async () => {
  const session = { options: { language: 'fr' }, position: { dataEpoch: 'epoch', sequence: '3' },
    deps: { environment: {} },
    query: async () => [{ collection: { value: collection },
      name: { value: 'Sélection', 'xml:lang': 'fr' } }],
    summaries: async () => [{ status: 'available', disclosure: 'public', type: 'work',
      name: { value: 'Book', language: 'fr', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', key: work, policy: 'test', resourceType: 'work' } }],
  } as unknown as WorkReadSession;
  expect(await readZoneEditorLists(session, realm, zoneRead, publicationRead, moduleRead)).toMatchObject({
    profile: 'zone-editor-lists-v1', lists: [{ collection, state: 'partial',
      name: { value: 'Sélection', language: 'fr' }, items: [{ id: work }] }] });
  await expect(readZoneEditorLists(session, realm, zoneRead,
    async () => ({ zone, realm, revision: realm, presentation,
      configuration: { presentation } }) as never, moduleRead))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
