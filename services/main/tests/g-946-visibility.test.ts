import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { spaceSettingsCommand, realmSettings } from '../src/modules/realm-admin/contract.ts';
import { pageDiscoveryHeaders, pageDiscoveryPolicy, readResourceVisibility, VISIBILITY_COST } from '../src/modules/space/visibility.ts';
import { realmHistoryCutFilter } from '../src/modules/realm-admin/history.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import type { Pool } from 'pg';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const uri = (value: string) => ({ type: 'uri',value });
const text = (value: string) => ({ type: 'literal',value });
const environment = (query: (sparql: string) => Promise<unknown>) => ({
  fuseki: { query },lineage: { dataEpoch: 'current',routingEpoch: 'current' },
  objectDirectory: '.temp/g-946-unit',
}) as WorkActivationEnvironment;

test('G-946: all four settings are independent; only public/listed is findable and unlisted sends no referrer', () => {
  for (const visibility of ['public','private'] as const) for (const listing of ['listed','unlisted'] as const)
    for (const history of ['everything','from-admission'] as const) for (const admission of ['open','request','invitation'] as const) {
      expect(Value.Check(spaceSettingsCommand, { actingSubject: id,expectedGeneration: '0',reason: 'Manage community',
        settings: { visibility,listing,history,admission } })).toBe(true);
      const discovery = pageDiscoveryPolicy(visibility,listing);
      expect(discovery.indexable).toBe(visibility === 'public' && listing === 'listed');
      expect(pageDiscoveryHeaders(discovery)['referrer-policy']).toBe(listing === 'unlisted' ? 'no-referrer' : undefined);
      expect(pageDiscoveryHeaders(discovery)['x-robots-tag']).toBe(discovery.indexable ? undefined : 'noindex');
    }
  expect(Value.Check(realmSettings, { visibility: 'public',reviewRequired: true,whoMaySubmit: 'granted',rules: [] })).toBe(true);
  expect(VISIBILITY_COST.rows).toBe(2);
});

test('G-946: history cuts compare complete restore lineage; missing/cyclic lineage fails closed', async () => {
  let bindings: Record<string, { type: string; value: string }>[] = [
    { epoch: text('current'),prior: text('older') },{ epoch: text('older'),prior: text('original') }];
  const env = environment(async () => ({ results: { bindings } }));
  expect(await realmHistoryCutFilter(env,{ dataEpoch: 'older',sequence: '12345678901234567890' }))
    .toBe('FILTER((?revisionEpoch = "older" && ?sequence > 12345678901234567890) || ?revisionEpoch IN ("current"))');
  bindings = [];
  await expect(realmHistoryCutFilter(env,{ dataEpoch: 'older',sequence: '1' })).rejects.toThrow(WorkReadUnavailable);
  bindings = [{ epoch: text('current'),prior: text('current') }];
  await expect(realmHistoryCutFilter(env,{ dataEpoch: 'older',sequence: '1' })).rejects.toThrow(WorkReadUnavailable);
});

test('G-946: the live predicate never turns an address, unlisted flag or request page into private read authority', async () => {
  let visibility = 'Public', listing = 'unlisted';
  const env = environment(async sparql => sparql.includes('SELECT DISTINCT')
    ? { results: { bindings: [{ kind: text('space'),space: uri(id),realm: uri(id),
      disclosure: uri(`${RV}${visibility}`),listing: text(listing),admission: text('request') }] } }
    : { boolean: true,results: { bindings: [{ epoch: text('current'),routing: text('current') }] } });
  expect(await readResourceVisibility(env,id)).toMatchObject({ readable: true,findable: false,listing: 'unlisted' });
  visibility = 'Private';
  expect(await readResourceVisibility(env,id)).toMatchObject({ readable: false,findable: false,admission: 'request' });
  expect(await readResourceVisibility(env,id,{ realmReadProof: async () => 'current membership' }))
    .toMatchObject({ readable: true,findable: false });
  visibility = 'Public'; listing = 'listed';
  expect(await readResourceVisibility(env,id)).toMatchObject({ readable: true,findable: true });
});

test('G-946: history-restricted counts exclude hidden parents and their descendants', async () => {
  const child = id.replace(/1$/, '2'), grandchild = id.replace(/1$/, '3'), current = id.replace(/1$/, '4');
  const content = { query: async () => ({ rows: [
    { thread: id,id: child,parent_reply: id,root_target: id,visible: true },
    { thread: id,id: grandchild,parent_reply: child,root_target: id,visible: true },
    { thread: id,id: current,parent_reply: id,root_target: id,visible: true },
  ] }) } as unknown as Pool;
  const store = new RealmReplyThreadStore(content, {} as Pool);
  const counted = await store.counts(id, [id], async () => new Set([grandchild,current]));
  expect(counted.complete).toBe(true);
  expect(counted.counts.get(id)).toBe(1);
});
