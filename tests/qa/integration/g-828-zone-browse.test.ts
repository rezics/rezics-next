import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const book = 'https://schema.org/Book';
type Page = { items: { id: string }[]; nextCursor: string | null;
  matches: { value: number; kind: string }; facets: Record<string, { value: string; count: number }[]> };

test('G828: HTTP traverses 1,000 adopted Works in every sort and Condition; public counts, relay, backfill and serial recovery', async () => {
  const stack = await startMediaStack('g-828-zone-browse');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const actor = id(), input = { name: `Traversal ${randomUUID()}`, actingSubject: actor };
    const created = await createRealmSpace(stack.env, stack.admission(actor, 'space:create:root', 'space.create',
      spaceCreationDigest(input)), input);
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm creation failed');
    const realm = created.realm, phrase = `traversal${randomUUID().replaceAll('-', '')}`, concept = id();
    // A bounded read fixture exercises the API over a large adopted inventory.
    // Selection command validation is covered by G657; these rows carry its
    // exact public-selection witnesses and native ranked MatchUnit identities.
    const works = Array.from({ length: 1000 }, (_, index) => ({ index, work: id(), main: id(),
      head: id(), slot: id(), selection: id(), contribution: id(), decision: id(), draft: id(), unit: id() }));
    const hidden = new Set(works.slice(0, 300).map(work => work.work));
    for (let start = 0; start < works.length; start += 64) {
      const batch = works.slice(start, start + 64);
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${batch.map(row => `
          ${iri(row.work)} a schema:CreativeWork, schema:Book ; rv:mainVersion ${iri(row.main)} ;
            rv:head ${iri(row.head)} ; rdfs:label ${lit(`Story ${row.index}`)}@en ;
            rv:completionStatus ${lit(row.index % 2 ? 'ongoing' : 'completed')} .
          ${hidden.has(row.work) ? '' : `${iri(row.work)} rv:catalogueVisible true .`}
          ${iri(row.main)} a rv:MainVersion ; rv:work ${iri(row.work)} .
          ${iri(row.contribution)} rv:publicationHead ${iri(row.decision)} .
          ${iri(row.slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ${iri(row.work)} ;
            rv:mainVersion ${iri(row.main)} ; rv:selectionHead ${iri(row.selection)} .`).join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${batch.map(row => `
          ${iri(row.selection)} a rv:PublicationSelection ; rv:component ${iri(row.slot)} ; rv:context ${iri(realm)} ;
            rv:work ${iri(row.work)} ; rv:mainVersion ${iri(row.main)} ; rv:contribution ${iri(row.contribution)} ;
            rv:publicationDecision ${iri(row.decision)} ; rv:selectedDraft ${iri(row.draft)} ; rv:language "en" ;
            rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ${row.index + 1} .
          ${iri(row.decision)} rv:disclosure rv:Public .`).join('\n')} }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${batch.map(row => `
          ${iri(row.unit)} a rv:MatchUnit ; rv:disclosure rv:Public ; rv:work ${iri(row.work)} ;
            rv:mainVersion ${iri(row.main)} ; rv:contribution ${iri(row.contribution)} ; rv:revision ${iri(row.draft)} ;
            rv:selection ${iri(row.selection)} ; rv:language "en" ; rv:realm ${iri(realm)} ;
            rv:context ${iri(realm)} ; rv:field rv:Body ; rv:searchBody ${lit(phrase)}@en .`).join('\n')} }
      }`);
    }
    const generation = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.serial_stats_checkpoint
      (singleton, generation, graph_epoch, sequence) VALUES (true,$1,$2,0)
      ON CONFLICT (singleton) DO UPDATE SET generation = $1, graph_epoch = $2, sequence = 0`,
    [generation, stack.env.lineage.dataEpoch]);
    await stack.accessPool.query(`INSERT INTO access.serial_summary (generation, work, word_count, last_updated_at)
      SELECT $1, value->>'work', (value->>'index')::bigint,
        CASE WHEN (value->>'index')::integer < 700 THEN '2026-09-20T00:00:00.000001Z'::timestamptz ELSE NULL END
      FROM jsonb_array_elements($2::jsonb)`, [generation, JSON.stringify(works)]);
    const projection = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    await expect(projection.batch(realm, 'newest', null)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await projection.backfill();
    await projection.backfill();
    expect((await stack.accessPool.query('SELECT count(*)::int AS n FROM access.zone_browse_entry WHERE realm = $1',
      [realm])).rows[0].n).toBe(1000);
    const tags = { active: async () => ({ stale: false }),
      workTerms: async (_: unknown, ids: string[]) => ids.filter(work => works.find(row => row.work === work)!.index % 3 === 0)
        .map(work => ({ work, concept })) };
    const sequence = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;
    await relay.query(`INSERT INTO relay.delivered_batch (data_epoch,sequence,batch_id,routing_epoch,event_count)
      VALUES ($1,$2,$3,$4,0)`, [stack.env.lineage.dataEpoch, sequence, id(), stack.env.lineage.routingEpoch]);
    await stack.accessPool.query('UPDATE access.serial_stats_checkpoint SET sequence = $1 WHERE singleton', [sequence]);
    const serialStats = new SerialStatisticsProjection(stack.accessPool, relay, stack.contentPool, stack.env);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, zoneBrowse: projection,
      serialStats, discovery: tags as never, account: { verify: async () => { throw new Error('Public browse requested authority'); } } });
    const path = `/v1/realms/${realm.slice(-36)}/modules/browse`;
    const read = async (params: URLSearchParams): Promise<Page> => {
      const response = await app.handle(new Request(`http://main.local${path}?${params}`));
      if (response.status !== 200) throw new Error(`Browse ${response.status}: ${await response.text()}`);
      return response.json() as Promise<Page>;
    };
    const traverse = async (sort: string, filter: Record<string, string> = {}) => {
      const params = new URLSearchParams({ sort, ...filter }), seen: string[] = [];
      let page: Page;
      do {
        page = await read(params);
        expect(page.items.every(item => !hidden.has(item.id))).toBe(true);
        seen.push(...page.items.map(item => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(page.matches).toEqual({ value: seen.length, kind: 'exact' });
      return seen;
    };
    for (const sort of ['newest', 'updated', 'relevance']) {
      const text = sort === 'relevance' ? { q: phrase } : {};
      const all = await traverse(sort, text);
      expect(all.length).toBe(700);
      expect(all.sort()).toEqual(works.filter(row => !hidden.has(row.work)).map(row => row.work).sort());
      for (const [filter, predicate] of [
        [{ type: book }, (_: typeof works[number]) => true],
        [{ status: 'completed' }, (row: typeof works[number]) => row.index % 2 === 0],
        [{ length: '950-' }, (row: typeof works[number]) => row.index >= 950],
        [{ concept }, (row: typeof works[number]) => row.index % 3 === 0],
        [{ excludeConcept: concept }, (row: typeof works[number]) => row.index % 3 !== 0],
      ] as const) {
        const result = await traverse(sort, { ...text, length: '950-', ...filter });
        expect(result.sort()).toEqual(works.filter(row => !hidden.has(row.work) && row.index >= 950 && predicate(row))
          .map(row => row.work).sort());
      }
    }
    expect(await traverse('newest', { language: 'ja' })).toEqual([]);

    // Equal microsecond timestamps retain their full key; nulls remain a
    // separate seek partition. Statistics changes are atomic with sort keys.
    const target = works[999]!;
    await stack.accessPool.query(`UPDATE access.serial_summary SET word_count = 12345,
      last_updated_at = '2026-09-20T00:00:00.000002Z' WHERE generation = $1 AND work = $2`, [generation, target.work]);
    const updated = await projection.batch(realm, 'updated', null);
    expect(updated[0]).toMatchObject({ work: target.work, words: 12345, updatedAt: '2026-09-20T00:00:00.000002Z' });
    await stack.accessPool.query('UPDATE access.serial_stats_checkpoint SET generation = $1 WHERE singleton', [randomUUID()]);
    expect((await projection.batch(realm, 'updated', null)).every(entry => entry.words === null && entry.updatedAt === null)).toBe(true);

    // Source replay observes the current selection rather than resurrecting
    // an older receipt; suppression removes a candidate idempotently.
    await stack.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target.slot)} <${RV}selectionHead> ${iri(target.selection)} } }`);
    await relay.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
      VALUES ('https://rezics.com/services/main',$1,$2,1001,$3::jsonb)`, [id(), stack.env.lineage.dataEpoch,
      JSON.stringify({ type: 'com.rezics.realm.publication-suppressed.v1',
        data: { receipt: { outcome: 'succeeded', realm, work: target.work } } })]);
    await relay.query(`INSERT INTO relay.delivered_batch (data_epoch,sequence,batch_id,routing_epoch,event_count)
      VALUES ($1,1001,$2,$3,1)`, [stack.env.lineage.dataEpoch, id(), stack.env.lineage.routingEpoch]);
    expect(await projection.tick()).toBe(1);
    expect(await projection.tick()).toBe(0);
    expect((await stack.accessPool.query('SELECT 1 FROM access.zone_browse_entry WHERE realm = $1 AND work = $2',
      [realm, target.work])).rowCount).toBe(0);
  } finally { await relay.end(); await stack.stop(); }
}, 600_000);
