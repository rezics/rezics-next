import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '../../../packages/observability/src/runtime.ts';
import { startWorkProfileSink, profileRequest, assertWorkCostAtScales } from '../../../tests/qa/support/work-profile.ts';
import { workProfileCorpusApi, type CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';

const sink = startWorkProfileSink({ settleMs: 25 });
startTelemetry('main',{ ...process.env,...sink.env,OTEL_SERVICE_NAME: 'main' });
const { startHomeStack } = await import('../../../tests/qa/integration/feed-read-support.ts');
const { ReadRankingProjection, rankingBuckets } = await import('../src/modules/rankings/projection.ts');
const { createMainApp } = await import('../src/app.ts');
const { admittedPage } = await import('../src/modules/disclosure/admitted-page.ts');
const { publicWork } = await import('../src/modules/work/public-patterns.ts');
const { iri } = await import('../src/modules/work/activate.ts');
const home = await startHomeStack('g-1025-ranking',{ projectionStart: 'current' });
const profiles = [], evidence = [];
try {
  const author = await home.provision('Ranking author',home.author.token);
  const api = workProfileCorpusApi('http://main.local',home.author.token,
    { fetch: ((input,init) => home.app.handle(new Request(input,init))) as typeof fetch });
  const bookApi: CorpusApi = { ...api,command: (key,command,signal) => api.command(key,{
    ...command,body: command.path === '/v1/works' ? { ...(command.body as object),semanticTypes: ['https://schema.org/Book'] } : command.body,
  },signal) };
  const target = await seedPublicProfileWork(api,'g1025:rank:target',{ actingSubject: author,title: 'Shared public chapter',body: 'Public chapter text' });
  const visible = await seedPublicProfileWork(bookApi,'g1025:rank:visible',{ actingSubject: author,title: 'Visible ranked Book',body: 'Public ranked Book' });
  const readBook = async (key: string, work: { work: string; mainVersion: string }, readings: number) => {
    const composition = await api.command<{ structure: string; revision: string }>(`${key}:composition`, {
      method: 'POST',path: '/v1/compositions',body: { profile: 'book-composition',work: work.work,
        mainVersion: work.mainVersion,actingSubject: author } });
    const changed = await api.command<{ occurrences: string[] }>(`${key}:chapters`, { method: 'POST',
      path: `/v1/compositions/${composition.structure.slice(-36)}/changes`,body: { profile: 'book-composition',
        expectedHead: composition.revision,actingSubject: author,operations: Array.from({ length: readings },()=>({
          op: 'insert',parent: composition.structure,position: 'last',role: 'chapter',target: target.work })) } });
    for (const [index, occurrence] of changed.occurrences.entries()) await api.command(`${key}:read:${index}`, {
      method: 'PUT',path: `/v1/compositions/${composition.structure.slice(-36)}/occurrences/${occurrence.slice(-36)}/progress`,
      body: { actingSubject: author,expectedVersion: 0,completed: false,position: null } });
  };
  await readBook('g1025:rank:visible',visible,1);
  const projection = new ReadRankingProjection(home.stack.accessPool,home.stack.content,home.stack.contentPool,home.stack.env);
  const app = createMainApp(home.stack.fuseki,{ ...home.deps,readRankings: projection });
  let built = 0;
  for (const rejected of [4,16,64]) {
    for (;built<rejected;built++) {
      const key = `g1025:rank:private:${built}`;
      const work = await api.command<{ work: string; mainVersion: string }>(`${key}:work`,{ method: 'POST',path: '/v1/works',
        body: { profile: 'metadata-only-v1',authoring: 'own-work',title: key,language: 'en',actingSubject: author,
          semanticTypes: ['https://schema.org/Book'] } });
      await readBook(key,work,2);
    }
    for (let tick=0;tick<200 && await projection.tick();tick++) { /* retained owner replay */ }
    const checkpoint = await projection.current(), bucket = rankingBuckets(new Date(),'day').current;
    const raw = (await home.stack.accessPool.query<{ work: string; score: string }>(`SELECT work,score::text
      FROM access.read_ranking_score WHERE generation=$1 AND metric='reads' AND interval='day' AND bucket=$2
      ORDER BY score DESC,work`,[checkpoint.generation,bucket])).rows;
    assert.equal(raw.length,rejected+1);
    assert.equal(raw.at(-1)!.work,visible.work);
    // Execute the former raw-score selection against this exact corpus.
    let oldSeeks = 0;
    const before = await admittedPage<{ work: string; score: string }>({ limit: 1,key: row=>row.work,
      fetch: async (after,size) => {
        oldSeeks++;
        return (await home.stack.accessPool.query<{ work: string; score: string }>(`SELECT work,score::text FROM access.read_ranking_score
          WHERE generation=$1 AND metric='reads' AND interval='day' AND bucket=$2
            AND ($3::bigint IS NULL OR score<$3 OR score=$3 AND work>$4)
          ORDER BY score DESC,work LIMIT $5`,[checkpoint.generation,bucket,after?.score ?? null,after?.work ?? '',size])).rows;
      }, admit: async rows => {
        const values = rows.map(row=>iri(row.work)).join(' ');
        const found = rows.length ? (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
          SELECT DISTINCT ?work WHERE { VALUES ?work { ${values} } ${publicWork('?work','?main')} }`)).results?.bindings ?? [] : [];
        const allowed = new Set(found.map(row=>row.work!.value));
        return rows.filter(row=>allowed.has(row.work));
      } });
    assert.deepEqual(before.page.map(row=>row.work),[visible.work]);
    for (const temperature of ['first','warm']) {
      const measured = await profileRequest(sink,async headers => {
        const response = await app.handle(new Request('http://main.local/v1/rankings/trending?metric=reads&interval=day&limit=1',{ headers }));
        const page = await response.json() as { items: { id: string; score: number }[]; nextCursor: string | null };
        assert.equal(response.status,200,JSON.stringify(page));
        assert.deepEqual(page.items.map(row=>({ id: row.id,score: row.score })),[{ id: visible.work,score: 1 }]);
        assert.equal(page.nextCursor,null);
      },{ service: 'main',flush: flushTelemetryTraces });
      profiles.push(measured.profile);
      const plan = (await home.stack.accessPool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)
        SELECT work FROM access.read_ranking_admitted WHERE generation=$1 AND metric='reads' AND interval='day'
          AND bucket=$2 AND context='urn:rezics:context:global' ORDER BY score DESC,work LIMIT 2`,[checkpoint.generation,bucket])).rows[0]!['QUERY PLAN'];
      evidence.push({ rejected,temperature,oldSeeks,newSeeks: 1,profile: measured.profile,plan });
      sink.clear();
    }
  }
  assertWorkCostAtScales(profiles,{ fusekiRequests: 12,postgresStatements: 12 });
  // Folding the review head into the checkpoint read must preserve missing
  // source rejection and the grace period for committed, unsequenced reviews.
  const reviewHead = (await home.stack.accessPool.query<{ position: string }>(
    'DELETE FROM access.reader_review_rank_head WHERE singleton RETURNING position::text')).rows[0]!;
  try {
    await assert.rejects(() => projection.current(), /catching up/);
  } finally {
    await home.stack.accessPool.query('INSERT INTO access.reader_review_rank_head(position) VALUES($1)',
      [reviewHead.position]);
  }
  const updated = (await home.stack.accessPool.query<{ updated_at: Date }>(
    'SELECT updated_at FROM access.read_ranking_checkpoint WHERE singleton')).rows[0]!;
  try {
    await home.stack.accessPool.query('SELECT access.append_reader_review_rank_change($1, clock_timestamp(), 1)',
      [visible.work]);
    await home.stack.accessPool.query(`UPDATE access.read_ranking_checkpoint
      SET updated_at=clock_timestamp() WHERE singleton`);
    await projection.current();
    await home.stack.accessPool.query(`UPDATE access.read_ranking_checkpoint
      SET updated_at=clock_timestamp() - interval '61 seconds' WHERE singleton`);
    await assert.rejects(() => projection.current(), /catching up/);
  } finally {
    await home.stack.accessPool.query('DELETE FROM access.reader_review_rank_change WHERE work=$1 AND position IS NULL',
      [visible.work]);
    await home.stack.accessPool.query('UPDATE access.read_ranking_checkpoint SET updated_at=$1 WHERE singleton',
      [updated.updated_at]);
  }
  await projection.current();
  // Strong revocation updates admission in its transaction, without a graph
  // rescan or stale denied prefix in the next page.
  await home.stack.accessPool.query(`INSERT INTO access.scope_gate(id,open) VALUES($1,false)
    ON CONFLICT(id) DO UPDATE SET open=false`,[`work:read:${visible.work}`]);
  const denied = await app.handle(new Request('http://main.local/v1/rankings/trending?metric=reads&interval=day&limit=1'));
  assert.equal(denied.status,200); assert.deepEqual((await denied.json() as { items: unknown[] }).items,[]);
  await home.stack.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1',[`work:read:${visible.work}`]);
  const reopened = await app.handle(new Request('http://main.local/v1/rankings/trending?metric=reads&interval=day&limit=1'));
  assert.equal(reopened.status,200); assert.deepEqual((await reopened.json() as { items: { id: string }[] }).items.map(row=>row.id),[visible.work]);
} finally {
  mkdirSync('.temp/work-profiles',{ recursive: true });
  writeFileSync(process.env.REZICS_WORK_PROFILE_RESULT ?? '.temp/work-profiles/g-1025-ranking.json',JSON.stringify(evidence,null,2)+'\n');
  await home.stop(); await shutdownTelemetry(); await sink.stop();
}
