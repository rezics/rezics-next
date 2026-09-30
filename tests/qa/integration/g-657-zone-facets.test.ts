import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, DATASET, GRAPHS, iri, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { commitMetadata } from '../../../services/main/src/modules/work/metadata-command.ts';
import { metadataDigest, type MetadataIntent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import { startMediaStack } from './media-support.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const book = 'https://schema.org/Book';
type Page = { items: { id: string; mod?: unknown }[]; facets: Record<string, unknown>; query: unknown };

// Real owner commands create the Fiction population. A fixed, restore-fenced composition
// projection fixture isolates query admission from the separate Content relay pipeline.
test('G657: registry Facets drive Fiction browse and Query; removed and unsupported inputs read no graph', async () => {
  const stack = await startMediaStack('g-657-zone-facets');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const admission = (scope: string, action: string, digest: string) => stack.admission(actor, scope, action, digest);
    const input = { name: `Fiction ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(stack.env, admission('space:create:root', 'space.create',
      spaceCreationDigest(input)), input);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('Fiction Realm creation failed');
    const realm = space.realm;
    const works: string[] = [];
    for (const [index, status] of ['completed', 'completed', 'ongoing'].entries()) {
      const title = `Fiction story ${index} ${randomUUID()}`;
      const created = await activateMetadataWork(stack.env, { title, semanticTypes: [book],
        admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title, [book])) });
      works.push(created.work);
      const metadata: MetadataIntent = { work: created.work, expectedHead: null,
        state: { kind: 'header', originalTitle: null,
          completionStatus: status as 'completed' | 'ongoing', localized: [] } };
      expect(await commitMetadata(stack.env, admission(`work:edit:${created.work}`, 'work.edit',
        metadataDigest(metadata)), metadata)).toBe(true);
      const text = await stack.contribution(created.work, actor, 'en', 'One short story.');
      const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: text.contribution, publicationDecision: text.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
      expect((await selectMainDefault(stack.env, admission(`publication:select:${created.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection)).outcome).toBe('succeeded');
      const adoption = { ...selection, mainVersion: created.mainVersion,
        context: { kind: 'realm-local' as const, id: realm }, selectionBasis: 'realm-manager-review' as const };
      expect((await selectRealmLocal(stack.env, admission(`publication:adopt:${realm}`,
        'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome).toBe('succeeded');
    }
    const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence }
    } LIMIT 1`)).results!.bindings;
    const sequence = rows[0]!.sequence!.value;
    const generation = randomUUID();
    await relay.query(`INSERT INTO relay.delivered_batch
      (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1,$2,$3,$4,0)`,
    [stack.env.lineage.dataEpoch, sequence, `urn:rezics:outbox:${randomUUID()}`, stack.env.lineage.routingEpoch]);
    await stack.accessPool.query(`INSERT INTO access.serial_stats_checkpoint
      (singleton, generation, graph_epoch, sequence) VALUES (true,$1,$2,$3)
      ON CONFLICT (singleton) DO UPDATE SET generation = $1, graph_epoch = $2, sequence = $3`,
    [generation, stack.env.lineage.dataEpoch, sequence]);
    for (const [index, work] of works.entries()) {
      await stack.accessPool.query(`INSERT INTO access.serial_summary
        (generation, work, chapter_count, word_count, last_updated_at) VALUES ($1,$2,1,$3,now())`,
      [generation, work, (index + 1) * 100]);
    }
    const stats = new SerialStatisticsProjection(stack.accessPool, relay, stack.contentPool, stack.env);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, serialStats: stats,
      account: { verify: async () => { throw new Error('Public browse made an authority request'); } } });
    const call = (path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }));
    const facets = await call('/v1/facets');
    expect(facets.status).toBe(200);
    const registry = await facets.json() as { facets: { name: string; labels: Record<string, string> }[] };
    for (const name of ['status', 'length']) {
      const facet = registry.facets.find(item => item.name === name)!;
      expect(facet).toBeDefined();
      expect(Object.keys(facet.labels)).toEqual(locales);
      expect(Object.values(facet.labels).every(label => label.trim().length > 0)).toBe(true);
    }
    const path = `/v1/realms/${realm.slice(-36)}/modules/browse`;
    const unfiltered = await call(path);
    expect(unfiltered.status).toBe(200);
    const baseline = await unfiltered.json() as Page;
    expect(baseline.items).toHaveLength(3);
    const filtered = await call(`${path}?status=completed&length=150-250`);
    expect(filtered.status).toBe(200);
    const page = await filtered.json() as Page;
    expect(page.items.map(item => item.id)).toEqual([works[1]!]);
    expect(Object.keys(page.facets).sort()).toEqual(['concept', 'length', 'status', 'type']);
    expect(page.items.every(item => !('mod' in item))).toBe(true);
    const base = { profile: 'filter-document-v2', context: { realm }, scope: { kind: 'realm', realm },
      sort: 'newest', page: { size: 20 } };
    const query = await call('/v1/query', { ...base, filter: { all: [
      { facet: 'status', any: ['completed'] }, { facet: 'length', range: { min: '150', max: '250' } },
    ] } });
    expect(query.status).toBe(200);
    expect((await query.json() as { result: Page }).result).toEqual(page);
    const excluded = await call('/v1/query', { ...base,
      filter: { all: [{ facet: 'status', none: ['completed'] }] } });
    expect(excluded.status).toBe(200);
    expect((await excluded.json() as { result: Page }).result.items.map(item => item.id)).toEqual([works[2]!]);
    const before = stack.fuseki.queries;
    for (const parameter of ['loader=Fabric', 'gameVersion=1.21', 'environment=client', 'requiredDependency=x']) {
      expect((await call(`${path}?${parameter}`)).status).toBe(400);
    }
    for (const condition of [{ facet: 'modLoader', any: ['Fabric'] }, { facet: 'language', any: ['en'] }]) {
      const refused = await call('/v1/query', { ...base, filter: { all: [condition] } });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: 'unsupported_query_shape' });
    }
    expect(stack.fuseki.queries).toBe(before);
  } finally { await relay.end(); await stack.stop(); }
}, 120_000);
