import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

const WORK_ID = 'OL45804W';

async function liveJson(url: string): Promise<{ bytes: Buffer; body: Record<string, unknown>;
  etag: string | null; lastModified: string | null; fetchedAt: string }> {
  const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000) });
  const fetchedAt = new Date().toISOString();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.length).toBeLessThanOrEqual(65_536);
  const body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  return { bytes, body, etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'), fetchedAt };
}

test('WORK08: live Work and Edition plus an authored equal-ID collision stay at separate grains without a parent', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  // Acquire each official response once in this run. The admitted bytes below are reused by
  // conversion, graph projection and native adoption; there is no second provider fetch.
  const work = await liveJson(`https://openlibrary.org/works/${WORK_ID}.json`);
  expect(work.body.key).toBe(`/works/${WORK_ID}`);
  expect((work.body.type as { key?: string })?.key).toBe('/type/work');
  await Bun.sleep(1_000);
  const page = await liveJson(`https://openlibrary.org/works/${WORK_ID}/editions.json?limit=1`);
  const entry = (page.body.entries as Array<{ key?: string }> | undefined)?.[0];
  expect(entry?.key).toMatch(/^\/books\/OL[1-9][0-9]*M$/);
  await Bun.sleep(1_000);
  const edition = await liveJson(`https://openlibrary.org${entry!.key}.json`);
  expect(edition.body.key).toBe(entry!.key);

  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `source-grain-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const intake = (namespace: string, externalId: string, bytes: Buffer, complete = true,
      revision: unknown = null) => ({
      profile: 'source-manual-intake-v1', provider: 'open-library', namespace, externalId,
      sourceRevision: typeof revision === 'number' && Number.isInteger(revision)
        ? `open-library-revision:${revision}` : null,
      mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: namespace === 'work' ? 'open-library-work-response-v1' : 'open-library-edition-response-v1',
        complete, omittedFields: complete ? [] : ['title'] },
      rightsEvidence: { basis: 'unknown', note: 'Official public API response; reuse not decided.' },
    });
    const liveWork = await h.intake.submit(h.principalId, `live-work-${randomUUID()}`,
      intake('work', WORK_ID, work.bytes, true, work.body.revision), { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${WORK_ID}.json`, status: 200,
        etag: work.etag, lastModified: work.lastModified, fetchedAt: work.fetchedAt });
    expect(liveWork.observation.rawBytesBase64).toBe(work.bytes.toString('base64'));
    expect(liveWork.observation.capture?.fetchedAt).toBe(work.fetchedAt);
    const editionId = entry!.key!.split('/').at(-1)!;
    const editionResponse = await h.call('POST', '/v1/sources/intakes',
      intake('edition', editionId, edition.bytes, true, edition.body.revision));
    const liveEdition = await h.json<{ observation: { record: string; observation: string } }>(editionResponse, 201);
    expect(liveEdition.observation.record).not.toBe(liveWork.observation.record);

    // Authored offline counterexample: Open Library Work and Edition keys have different
    // suffixes, so the provider cannot supply the same external ID in both grains on demand.
    const collision = Buffer.from(JSON.stringify({ key: `/books/${WORK_ID}`,
      type: { key: '/type/edition' }, title: work.body.title }));
    const collisionBody = intake('edition', WORK_ID, collision);
    const collisionKey = `grain-${randomUUID()}`;
    const pair = await Promise.all([1, 2].map(() => h.call('POST', '/v1/sources/intakes',
      collisionBody, collisionKey)));
    expect(pair.map(response => response.status).sort()).toEqual([200, 201]);
    const collisionObservations = await Promise.all(pair.map(response => response.json())) as
      Array<{ observation: { record: string; observation: string } }>;
    expect(collisionObservations[0]!.observation).toEqual(collisionObservations[1]!.observation);
    const otherGrain = collisionObservations[0]!.observation;
    expect(otherGrain.record).not.toBe(liveWork.observation.record);
    expect((await h.call('POST', '/v1/sources/intakes', { ...collisionBody, sourceRevision: 'changed' },
      collisionKey)).status).toBe(409);
    expect((await h.call('GET', `/v1/sources/observations/${shortId(otherGrain.observation)}`,
      undefined, randomUUID(), h.account.tokenB)).status).toBe(404);
    expect((await h.call('POST', '/v1/sources/intakes', collisionBody,
      randomUUID(), h.account.noScope)).status).toBe(401);

    const convertPath = (observation: string) =>
      `/v1/sources/observations/${shortId(observation)}/conversions/open-library-work`;
    const convertBody = { profile: 'open-library-work-map-v1' };
    expect((await h.call('POST', convertPath(liveEdition.observation.observation), convertBody)).status).toBe(422);
    expect((await h.call('POST', convertPath(otherGrain.observation), convertBody)).status).toBe(422);
    const partial = await h.intake.submit(h.principalId, `partial-${randomUUID()}`,
      intake('work', WORK_ID, work.bytes, false, work.body.revision), { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${WORK_ID}.json`, status: 200,
        etag: work.etag, lastModified: work.lastModified, fetchedAt: work.fetchedAt });
    expect((await h.call('POST', convertPath(partial.observation.observation), convertBody)).status).toBe(422);
    const converted = await h.json<{ conversion: { conversion: string; projection: { title: string } } }>(
      await h.call('POST', convertPath(liveWork.observation.observation), convertBody), 201);
    expect(converted.conversion.projection.title).toBe(work.body.title);
    const conversionId = shortId(converted.conversion.conversion);
    await h.json(await h.call('POST', `/v1/sources/conversions/${conversionId}/source-graph`,
      { profile: 'source-open-library-work-v1' }), 200);
    const proposed = await h.json<{ proposal: { proposal: string; candidateTitle: string } }>(
      await h.call('POST', `/v1/sources/conversions/${conversionId}/proposals/native-work`,
        { profile: 'open-library-native-work-proposal-v1' }), 201);
    const adoptionPath = `/v1/sources/proposals/${shortId(proposed.proposal.proposal)}/adoption/native-work`;
    const adoptionBody = { profile: 'source-native-work-adoption-v1',
      confirmedTitle: proposed.proposal.candidateTitle, actingSubject: h.actor, titleLanguage: 'en' };
    expect((await h.call('POST', adoptionPath, adoptionBody, randomUUID(), h.account.noScope)).status).toBe(401);
    const first = await h.json<{ adoption: { work: string; workRevision: string } }>(
      await h.call('POST', adoptionPath, adoptionBody), 201);
    // Discarding the first response models a lost acknowledgement. The owner receipt
    // recovers the same native Work and revision on an authorized retry.
    const recovered = await h.json<{ adoption: { work: string; workRevision: string } }>(
      await h.call('POST', adoptionPath, adoptionBody), 200);
    expect(recovered.adoption).toEqual(first.adoption);

    const rows = await h.pool.query<{ id: string; namespace: string; external_id: string }>(`
      SELECT id, namespace, external_id FROM source.record WHERE provider = 'open-library'
        AND id = ANY($1::uuid[])`, [[shortId(liveWork.observation.record),
        shortId(liveEdition.observation.record), shortId(otherGrain.record)]]);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map(row => `${row.namespace}:${row.external_id}`).sort()).toEqual([
      `edition:${WORK_ID}`, `edition:${editionId}`, `work:${WORK_ID}`].sort());
    const bindings = await h.pool.query<{ record_id: string; work: string }>(`
      SELECT p.record_id, b.work FROM source.native_work_binding b
      JOIN source.native_work_proposal p ON p.id = b.proposal_id
      WHERE p.record_id = ANY($1::uuid[])`, [[shortId(liveWork.observation.record),
        shortId(liveEdition.observation.record), shortId(otherGrain.record)]]);
    expect(bindings.rows).toEqual([{ record_id: shortId(liveWork.observation.record),
      work: first.adoption.work }]);
    const editionIris = [liveEdition.observation.record, otherGrain.record,
      `https://openlibrary.org${entry!.key}`, `https://openlibrary.org/books/${WORK_ID}`];
    for (const editionIri of editionIris) {
      expect((await h.nativeFuseki.query(`ASK { VALUES ?graph {
        <urn:rezics:graph:source> <urn:rezics:graph:current> }
        GRAPH ?graph { { <${editionIri}> ?p ?o } UNION { ?s ?p <${editionIri}> } } }`)).boolean).toBe(false);
    }

    // The source-record lookup is a unique (provider, namespace, external_id) probe.
    // Unrelated records cannot make this operation scan the provider corpus.
    const plan = await h.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM source.record
      WHERE provider = 'open-library' AND namespace = 'edition' AND external_id = $1`, [WORK_ID]);
    expect(plan.rows.map(row => row['QUERY PLAN']).join(' ')).toContain('record_provider_namespace_external_id_key');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 90_000);
