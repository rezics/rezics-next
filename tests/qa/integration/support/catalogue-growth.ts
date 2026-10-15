import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { startMediaStack } from '../media-support.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../../services/main/src/modules/work/select-realm.ts';
import { discoveryGrowthMeter } from './discovery-growth.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../../services/main/src/modules/outbox/relay.ts';
import { Pool } from 'pg';
import { prepareSqlReadWork } from './sql-read-work.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../../services/main/src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../../services/main/src/modules/outbox/relay-position.ts';

const schema = 'https://schema.org/';
export const zoneTypes: Record<string, string> = {
  books: schema + 'Book', fiction: schema + 'Book', manga: schema + 'Book',
  'light-novels': schema + 'Book', 'visual-novels': schema + 'VideoGame',
  anime: schema + 'TVSeries', games: schema + 'VideoGame',
  software: schema + 'SoftwareApplication', mods: 'https://rezics.com/vocab/ModPackage',
  'ai-workshop': 'https://rezics.com/vocab/PromptTemplate', 'franchise-wiki': schema + 'Book',
};
interface Page { items: { id: string }[]; nextCursor: string | null; window: { complete: boolean } }

export function catalogueGrowthTest(group: string, selectedTypes: readonly string[], ranked = false) {
test(`${group} Zone catalogue browse and search seeks a bounded page as Works grow`, async () => {
  expect(Object.keys(zoneTypes).sort()).toEqual(readdirSync('apps/web/zones/official', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort());
  const selected = Object.fromEntries(Object.entries(zoneTypes).filter(([, type]) => selectedTypes.includes(type)));
  expect(Object.keys(selected).length).toBeGreaterThan(0);
  await prepareSqlReadWork();
  const meter = discoveryGrowthMeter();
  const stack = await startMediaStack(`public-catalogue-${group}-growth`, { profileCredits: true });
  const started = performance.now();
  const relay = new Pool({ connectionString: process.env.ACCOUNT_RELAY_DATABASE_URL });
  let failures: string[] = [];
  try {
    const owner = await stack.member('catalogue-growth-owner');
    await owner.grant('space:create:root', 'space.create');
    const zones: { slug: string; realm: string; type: string }[] = [];
    for (const [slug, type] of Object.entries(selected)) {
      const response = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
        name: `${slug} growth catalogue`, capabilities: ['realm'], actingSubject: owner.actor });
      expect(response.status, await response.clone().text()).toBe(201);
      zones.push({ slug, type, realm: (await response.json() as { realm: string }).realm });
    }
    const populations = new Map<string, number>();
    for (const size of [12, 24, 48]) {
      for (const type of new Set(Object.values(selected))) {
        for (let index = populations.get(type) ?? 0; index < size; index++) {
          const work = await stack.publicWork(owner.actor, ['en'], `Growth catalogue ${index}`, [type]);
          for (const zone of zones.filter(zone => zone.type === type)) {
            const input = { context: { kind: 'realm-local' as const, id: zone.realm },
              work: work.work, mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
              publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
              selectionBasis: 'realm-manager-review' as const, actingSubject: owner.actor };
            const result = await selectRealmLocal(stack.env, stack.admission(owner.actor,
              `publication:adopt:${zone.realm}`, 'publication.adopt', realmSelectionDigest(input)), input);
            expect(result.outcome).toBe('succeeded');
          }
        }
        populations.set(type, size);
      }
      expect(performance.now() - started, 'fixture preparation stays below ten minutes').toBeLessThan(600_000);
      const consumer = stack.composition.relayConsumer!;
      await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
      // Drain the seed's captured cut, rather than chasing a moving worker tail.
      const cut = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} .
          ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?sequence } } LIMIT 2`, 8192)).results!.bindings!;
      expect(cut).toHaveLength(1);
      const target = BigInt(cut[0]!.sequence!.value);
      for (;;) {
        const checkpoint = await relay.query<{ sequence: string }>('SELECT sequence::text FROM relay.checkpoint WHERE consumer=$1', [consumer]);
        if (BigInt(checkpoint.rows[0]!.sequence) >= target) break;
        expect(await relayMainOutboxOnce(stack.fuseki, relay, consumer)).not.toBeNull();
        expect(performance.now() - started, 'Main relay preparation stays below ten minutes').toBeLessThan(600_000);
      }
      const projection = stack.composition.dependencies.zoneBrowse!;
      // Explicit preparation resumes the owner's bounded recovery passes.
      // A later test in the same shard may inherit more retained batches than
      // one pass can verify. Ready projections only consume their new tail.
      while (projection.recoveryStatus().state !== 'ready') {
        try { await projection.backfill(); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'Zone browse reconciliation exceeded its preparation page budget') throw error;
        }
        expect(performance.now() - started, 'projection preparation stays below ten minutes').toBeLessThan(600_000);
      }
      for (let tick = 0; tick < 400; tick++) {
        await projection.catchUp();
        if (await projection.current({ dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' })) break;
      }
      for (const zone of zones) {
        const root = `/v1/realms/${zone.realm.slice(-36)}/modules/browse`;
        // An unmatched bounded scan may be incomplete even on a current
        // projection. Observe current coverage, then actual public cards.
        expect(await projection.current({ dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' })).toBe(true);
        const ready = await stack.call('GET', `${root}?${new URLSearchParams({ limit: '2', type: zone.type })}`);
        const readyText = await ready.text();
        expect(ready.status, readyText).toBe(200);
        expect((JSON.parse(readyText) as Page).items).toHaveLength(2);
        for (const mode of ['browse', 'search']) {
          let cursor: string | null = null;
          const seen = new Set<string>();
          for (let page = 0; page < 2; page++) {
            const query = new URLSearchParams({ limit: '2', type: zone.type,
              ...(mode === 'search' ? { q: 'Growth catalogue' } : {}), ...(cursor ? { cursor } : {}) });
            const result = await meter.measure<Page>(stack, `${zone.slug}/${mode}`, size, page,
              () => stack.call('GET', `${root}?${query}`));
            expect(result.items).toHaveLength(2);
            for (const item of result.items) {
              expect(seen.has(item.id)).toBe(false);
              seen.add(item.id);
            }
            expect(result.nextCursor).toBeString();
            cursor = result.nextCursor;
          }
        }
      }
      if (ranked) {
      let rankedCursor: string | null = null;
      const rankedSeen = new Set<string>();
      for (let page = 0; page < 2; page++) {
        const query = new URLSearchParams({ q: 'Growth catalogue', limit: '2',
          ...(rankedCursor ? { cursor: rankedCursor } : {}) });
        const ranked = await meter.measure<{ results: { work: string }[]; next: string | null }>(stack,
          'catalogue/ranked', size * new Set(Object.values(selected)).size, page,
          () => stack.call('GET', `/v1/search/catalogue?${query}`));
        expect(ranked.results).toHaveLength(2);
        for (const item of ranked.results) { expect(rankedSeen.has(item.work)).toBe(false); rankedSeen.add(item.work); }
        expect(ranked.next).toBeString();
        rankedCursor = ranked.next;
        const work = meter.evidence.at(-1)!.native.counters;
        expect((work.rank_lucene_iterator_next_calls ?? 0) + (work.rank_lucene_iterator_advance_calls ?? 0)).toBeGreaterThan(0);
      }
      // Typeahead exposes a bounded suggestion set with hasMore, no public
      // continuation. Do not label a repeated first page as a second page.
      const suggestions = await meter.measure<{ items: unknown[]; hasMore: boolean }>(stack,
        'typeahead', size * new Set(Object.values(selected)).size, 0,
        () => stack.call('GET', '/v1/search/typeahead?prefix=growth'));
      expect(suggestions.items).toHaveLength(10);
      expect(suggestions.hasMore).toBe(true);
      expect(meter.evidence.at(-1)!.native.counters.typeahead_prefix_entries_visited).toBeGreaterThan(0);
      }
    }
  } finally {
    failures = meter.finish(`catalogue-${group}`);
    meter.restore();
    await relay.end();
    await stack.stop();
  }
  expect(failures, failures.join('\n')).toEqual([]);
}, 480_000);

}
