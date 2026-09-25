import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';

test('LIVE01/LIVE02/LIVE04/LIVE07/LIVE13: source conversion preserves field and child evidence without native adoption', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const issuer = 'https://qa-source-conversion.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const intake = new SourceIntakeStore(contentPool);
  const conversions = new OpenLibraryConversionStore(contentPool, intake);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/open-library-conversion-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer owner' && ['source:convert', 'source:read'].includes(required[0]!)) return owner;
      if (token === 'Bearer other' && required[0] === 'source:read') return other;
      throw new AccountAssertionDenied('scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool), sourceIntake: intake,
    sourceConversions: conversions,
  });
  const payload = (key: string, type = '/type/work') =>
    Buffer.from(JSON.stringify({ key, type: { key: type }, title: 'Source title',
      description: { value: 'Source expression' },
      authors: [{ author: { key: '/authors/OL1A' }, type: { key: '/type/author_role' } }],
      subjects: ['Foxes'], covers: [0], new_provider_field: { observed: true } }));
  const capture = (workId: string) => ({ profile: 'open-library-work-acquisition-v1' as const,
    url: `https://openlibrary.org/works/${workId}.json`, status: 200 as const,
    etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
  const submit = (workId: string, bytes: Buffer, complete = true) => intake.submit(ownerId,
    `capture-${randomUUID()}`, { provider: 'open-library', namespace: 'work',
      externalId: workId, sourceRevision: 'open-library-revision:1',
      mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' } }, capture(workId));
  const post = (token: string, observation: string) => app.handle(new Request(
    `http://main.local/v1/sources/observations/${observation}/conversions/open-library-work`,
    { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'open-library-work-map-v1' }) }));
  const read = (token: string, conversion: string) => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${conversion}`,
    { headers: { authorization: `Bearer ${token}` } }));
  const drift = (token: string, base: string, candidate: string) => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${base}/drift/${candidate}`,
    { headers: { authorization: `Bearer ${token}` } }));
  const children = (token: string, base: string, candidate: string) => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${base}/child-correspondences/${candidate}`,
    { headers: { authorization: `Bearer ${token}` } }));
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const workId = 'OL45804W';
    const observed = await submit(workId, payload(`/works/${workId}`));
    const observationId = observed.observation.observation.split('/').at(-1)!;
    expect((await post('other', observationId)).status).toBe(401);
    const created = await post('owner', observationId);
    expect(created.status).toBe(201);
    const first = await created.json() as { conversion: {
      conversion: string; observation: string; profile: string; sourceDigest: string;
      projection: { sourceKey: string; title: string; description: string;
        authorRefs: Array<{ sourceKey: string }>; subjects: string[] };
      fieldInventory: Array<{ field: string; disposition: string }> }; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(first.conversion).toMatchObject({ profile: 'open-library-work-source-conversion-v1',
      observation: observed.observation.observation,
      sourceDigest: observed.observation.byteDigest,
      projection: { sourceKey: `/works/${workId}`, title: 'Source title',
        description: 'Source expression',
        authorRefs: [{ sourceKey: '/authors/OL1A' }], subjects: ['Foxes'] } });
    expect(first.conversion.fieldInventory.find(field => field.field === 'new_provider_field'))
      .toEqual({ field: 'new_provider_field', disposition: 'unmapped-retained' });
    expect(first.conversion.fieldInventory.find(field => field.field === 'covers'))
      .toEqual({ field: 'covers', disposition: 'retained-only' });
    expect(first.conversion.fieldInventory).toHaveLength(8);
    const replay = await post('owner', observationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ conversion: first.conversion, replayed: true });
    const conversionId = first.conversion.conversion.split('/').at(-1)!;
    expect(await (await read('owner', conversionId)).json()).toEqual(first.conversion);
    expect((await read('other', conversionId)).status).toBe(404);
    const changedBytes = Buffer.from(JSON.stringify({ key: `/works/${workId}`,
      type: { key: '/type/work' }, title: 'Changed title',
      authors: [{ author: { key: '/authors/OL1A' }, type: { key: '/type/author_role' } }],
      subjects: ['Foxes'], covers: null, new_provider_field: { observed: true },
      newly_seen: 0 }));
    const changed = await submit(workId, changedBytes);
    const changedResponse = await post('owner', changed.observation.observation.split('/').at(-1)!);
    expect(changedResponse.status).toBe(201);
    const changedConversion = (await changedResponse.json() as { conversion: { conversion: string } })
      .conversion.conversion.split('/').at(-1)!;
    const comparison = await drift('owner', conversionId, changedConversion);
    expect(comparison.status).toBe(200);
    const driftResult = await comparison.json() as { record: string; representationChanged: boolean;
      fields: Array<{ field: string; status: string; baseDisposition: string | null;
        candidateDisposition: string | null }> };
    expect(driftResult.record).toBe(observed.observation.record);
    expect(driftResult.representationChanged).toBe(true);
    expect(Object.fromEntries(driftResult.fields.map(field => [field.field, field.status])))
      .toMatchObject({ title: 'changed', description: 'removed', covers: 'changed',
        newly_seen: 'added', authors: 'unchanged', key: 'unchanged' });
    expect(driftResult.fields.find(field => field.field === 'newly_seen'))
      .toMatchObject({ baseDisposition: null, candidateDisposition: 'unmapped-retained' });
    expect((await drift('other', conversionId, changedConversion)).status).toBe(404);
    const simpleChildren = await children('owner', conversionId, changedConversion);
    expect(simpleChildren.status).toBe(200);
    const simpleFields = (await simpleChildren.json() as { fields: Array<{
      field: string; coverage: string; base: Array<{ status: string;
        correspondence: string | null }>; candidate: Array<{ occurrence: string }> }> }).fields;
    expect(simpleFields.find(field => field.field === 'authors')).toMatchObject({
      coverage: 'complete', base: [{ status: 'matched' }] });
    expect(simpleFields.find(field => field.field === 'authors')!.base[0]!.correspondence)
      .toBe(simpleFields.find(field => field.field === 'authors')!.candidate[0]!.occurrence);
    const repeatedBase = await submit(workId, Buffer.from(JSON.stringify({
      key: `/works/${workId}`, type: { key: '/type/work' }, title: 'Repeated children',
      authors: [{ author: { key: '/authors/OL1A' }, type: { key: '/type/writer' } },
        { author: { key: '/authors/OL2A' } },
        { author: { key: '/authors/OL1A' }, type: { key: '/type/editor' } }],
      subjects: ['Foxes', 'Bears', 'Foxes'],
    })));
    const repeatedCandidate = await submit(workId, Buffer.from(JSON.stringify({
      key: `/works/${workId}`, type: { key: '/type/work' }, title: 'Repeated children',
      authors: [{ author: { key: '/authors/OL1A' }, type: { key: '/type/editor' } },
        { author: { key: '/authors/OL1A' }, type: { key: '/type/writer' } },
        { author: { key: '/authors/OL2A' } }],
      subjects: ['Foxes', 'Foxes', 'Bears'],
    })));
    const repeatedBaseResponse = await post('owner',
      repeatedBase.observation.observation.split('/').at(-1)!);
    const repeatedCandidateResponse = await post('owner',
      repeatedCandidate.observation.observation.split('/').at(-1)!);
    const repeatedBaseId = (await repeatedBaseResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    const repeatedCandidateId = (await repeatedCandidateResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    const repeatedResponse = await children('owner', repeatedBaseId, repeatedCandidateId);
    expect(repeatedResponse.status).toBe(200);
    const repeated = await repeatedResponse.json() as { fields: Array<{ field: string;
      coverage: string; base: Array<{ occurrence: string; ordinal: number;
        sourceKey: string; status: string; correspondence: string | null }>;
      candidate: Array<{ occurrence: string; status: string }> }> };
    const authors = repeated.fields.find(field => field.field === 'authors')!;
    const subjects = repeated.fields.find(field => field.field === 'subjects')!;
    expect(authors.coverage).toBe('complete');
    expect(authors.base.map(item => item.status)).toEqual([
      'ambiguous', 'matched', 'ambiguous']);
    expect(authors.candidate.map(item => item.status)).toEqual([
      'ambiguous', 'ambiguous', 'matched']);
    expect(authors.base[0]!.occurrence).not.toBe(authors.base[2]!.occurrence);
    expect(authors.base[1]!.correspondence).toBe(authors.candidate[2]!.occurrence);
    expect(authors.base[0]!.correspondence).toBeNull();
    expect(subjects.base.map(item => item.status)).toEqual([
      'ambiguous', 'matched', 'ambiguous']);
    expect(subjects.base[1]!.correspondence).toBe(subjects.candidate[2]!.occurrence);
    const missingAuthors = await submit(workId, Buffer.from(JSON.stringify({
      key: `/works/${workId}`, type: { key: '/type/work' }, title: 'Missing list',
      subjects: ['Foxes'],
    })));
    const missingResponse = await post('owner',
      missingAuthors.observation.observation.split('/').at(-1)!);
    const missingId = (await missingResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    const unavailable = await children('owner', repeatedBaseId, missingId);
    expect(unavailable.status).toBe(200);
    expect((await unavailable.json() as { fields: Array<{ field: string;
      coverage: string; base: Array<{ status: string }> }> }).fields
      .find(field => field.field === 'authors')).toMatchObject({
        coverage: 'unavailable', base: [{ status: 'unresolved' },
          { status: 'unresolved' }, { status: 'unresolved' }] });
    expect((await children('other', repeatedBaseId, repeatedCandidateId)).status).toBe(404);
    expect((await drift('owner', conversionId, conversionId)).status).toBe(200);
    const reformatted = await submit(workId, Buffer.from(JSON.stringify(JSON.parse(
      changedBytes.toString('utf8')), null, 2)));
    const reformattedResponse = await post('owner',
      reformatted.observation.observation.split('/').at(-1)!);
    const reformattedId = (await reformattedResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    const lexicalOnly = await (await drift('owner', changedConversion, reformattedId)).json() as {
      representationChanged: boolean; fields: Array<{ status: string }> };
    expect(lexicalOnly.representationChanged).toBe(true);
    expect(lexicalOnly.fields.every(field => field.status === 'unchanged')).toBe(true);
    const different = await submit('OL3W', payload('/works/OL3W'));
    const differentResponse = await post('owner', different.observation.observation.split('/').at(-1)!);
    const differentConversion = (await differentResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    expect((await drift('owner', conversionId, differentConversion)).status).toBe(422);
    expect((await children('owner', conversionId, differentConversion)).status).toBe(422);
    let nested: unknown = 0;
    for (let depth = 0; depth < 130; depth++) nested = { child: nested };
    const deeplyNested = await submit(workId, Buffer.from(JSON.stringify({
      key: `/works/${workId}`, type: { key: '/type/work' }, title: 'Deep',
      unknown_nested_field: nested,
    })));
    const deeplyNestedResponse = await post('owner',
      deeplyNested.observation.observation.split('/').at(-1)!);
    expect(deeplyNestedResponse.status).toBe(201);
    const deeplyNestedId = (await deeplyNestedResponse.json() as { conversion: {
      conversion: string } }).conversion.conversion.split('/').at(-1)!;
    expect((await drift('owner', conversionId, deeplyNestedId)).status).toBe(422);
    await expect(contentPool.query('UPDATE source.conversion SET source_digest = $2 WHERE id = $1',
      [conversionId, '0'.repeat(64)])).rejects.toThrow();
    const partial = await submit('OL1W', payload('/works/OL1W'), false);
    expect((await post('owner', partial.observation.observation.split('/').at(-1)!)).status).toBe(422);
    const edition = await submit('OL2W', payload('/works/OL2W', '/type/edition'));
    expect((await post('owner', edition.observation.observation.split('/').at(-1)!)).status).toBe(422);
    const graph = await fuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
      <${observed.observation.record}> a <https://schema.org/CreativeWork> . } }`);
    expect(graph.boolean).toBe(false);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
