import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore }
  from '../../../services/main/src/modules/source/native-work-proposal.ts';

class WrongProfileFuseki extends FusekiClient {
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    return super.commandWithReceipt({ ...envelope,
      validations: envelope.validations.map(validation => ({ ...validation,
        sha256: '0'.repeat(64) })) });
  }
}

class InvalidTitleFuseki extends FusekiClient {
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    const expected = `rv:sourceTitle ${JSON.stringify('Source "Work"')}`;
    if (!envelope.update.includes(expected)) throw new Error('source fixture title not found');
    return super.commandWithReceipt({ ...envelope,
      update: envelope.update.replace(expected, 'rv:sourceTitle ""') });
  }
}

test('LIVE01/LIVE02/LIVE07: private source graph projects retained Work evidence without native adoption', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const issuer = 'https://qa-source-graph.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const intake = new SourceIntakeStore(contentPool);
  const conversions = new OpenLibraryConversionStore(contentPool, intake);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const sourceGraph = new OpenLibrarySourceGraph(fuseki,
    { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    conversions);
  const sourceProposals = new SourceNativeWorkProposalStore(contentPool, sourceGraph, conversions);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/source-graph-projection-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer owner') return owner;
      if (token === 'Bearer read-only' && required[0] === 'source:read') return owner;
      if (token === 'Bearer other') return other;
      throw new AccountAssertionDenied('scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool),
    sourceIntake: intake, sourceConversions: conversions, sourceGraph, sourceProposals,
  });
  const call = (token: string, conversion: string, method: 'GET' | 'POST') => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${conversion}/source-graph`, {
      method, headers: { authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ profile: 'source-open-library-work-v1' }) } : {}),
    }));
  const propose = (token: string, conversion: string) => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${conversion}/proposals/native-work`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'open-library-native-work-proposal-v1' }),
    }));
  const readProposal = (token: string, proposal: string) => app.handle(new Request(
    `http://main.local/v1/sources/proposals/${proposal}`, {
      headers: { authorization: `Bearer ${token}` },
    }));
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const workId = 'OL45804W';
    const bytes = Buffer.from(JSON.stringify({ key: `/works/${workId}`,
      type: { key: '/type/work' }, title: 'Source "Work"',
      description: { value: 'Private\nsource expression' },
      authors: [{ author: { key: '/authors/OL1A' }, type: { key: '/type/author_role' } }],
      subjects: ['Library', 'Books'] }));
    const observed = await intake.submit(ownerId, `source-graph-${randomUUID()}`, {
      provider: 'open-library', namespace: 'work', externalId: workId,
      sourceRevision: 'open-library-revision:7', mediaType: 'application/json',
      retention: 'retained', rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: 'Scope still under review' },
    }, { profile: 'open-library-work-acquisition-v1',
      url: `https://openlibrary.org/works/${workId}.json`, status: 200,
      etag: '"r7"', lastModified: null, fetchedAt: new Date().toISOString() });
    const converted = await conversions.convert(ownerId, observed.observation.observation.split('/').at(-1)!);
    expect(converted).not.toBeNull();
    const conversionId = converted!.conversion.conversion.split('/').at(-1)!;
    const forbiddenReceipt = `urn:rezics:receipt:${randomUUID().replaceAll('-', '').repeat(2)}`;
    await expect(fuseki.command({ receipt: forbiddenReceipt, digest: 'a'.repeat(64),
      update: `INSERT DATA { GRAPH <urn:rezics:graph:source> {
        <${observed.observation.record}> a <https://rezics.com/vocab/SourceRecord> . }
        GRAPH <urn:rezics:graph:receipts> {
          <${forbiddenReceipt}> a <https://rezics.com/vocab/OperationReceipt> . } }`,
      validations: [], deadlineMs: 10_000 })).rejects.toThrow('source graph requires its fixed receipt family');
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:receipts> {
      <${forbiddenReceipt}> ?p ?o . } }`)).boolean).toBe(false);
    expect((await call('owner', conversionId, 'GET')).status).toBe(404);
    expect((await propose('owner', conversionId)).status).toBe(409);
    expect((await contentPool.query('SELECT id FROM source.native_work_proposal WHERE principal_id = $1',
      [ownerId])).rowCount).toBe(0);
    expect((await propose('read-only', conversionId)).status).toBe(401);
    expect((await propose('other', conversionId)).status).toBe(404);
    expect((await call('read-only', conversionId, 'POST')).status).toBe(401);
    expect((await call('other', conversionId, 'POST')).status).toBe(404);
    const wrongProfile = new OpenLibrarySourceGraph(new WrongProfileFuseki(Bun.env.FUSEKI_URL),
      { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      conversions);
    await expect(wrongProfile.project(ownerId, conversionId))
      .rejects.toThrow('Fuseki command unknown-profile');
    const invalidTitle = new OpenLibrarySourceGraph(new InvalidTitleFuseki(Bun.env.FUSEKI_URL),
      { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      conversions);
    await expect(invalidTitle.project(ownerId, conversionId))
      .rejects.toThrow('Fuseki command invalid');
    const sourceReceipt = `urn:rezics:receipt:source-projection:${createHash('sha256')
      .update(converted!.conversion.conversion).digest('hex')}`;
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:receipts> {
      <${sourceReceipt}> ?p ?o . } }`)).boolean).toBe(false);
    const response = await call('owner', conversionId, 'POST');
    expect(response.status).toBe(200);
    const first = await response.json() as { state: string; record: string; observation: string;
      conversion: string; sourceDigest: string; receipt: string;
      sourcePosition: { dataEpoch: string; sequence: string };
      projection: { title: string; description: string; authorRefs: unknown[]; subjects: string[] } };
    expect(first).toMatchObject({ state: 'staged', record: observed.observation.record,
      conversion: converted!.conversion.conversion,
      sourceDigest: observed.observation.byteDigest,
      projection: { title: 'Source "Work"', description: 'Private\nsource expression',
        authorRefs: [{ sourceKey: '/authors/OL1A' }], subjects: ['Library', 'Books'] } });
    expect(first.receipt).toMatch(/^urn:rezics:receipt:source-projection:[0-9a-f]{64}$/);
    expect(first.sourcePosition.dataEpoch).toBe(Bun.env.MAIN_DATA_EPOCH);
    const batch = await readNextMainOutboxBatch(fuseki, first.sourcePosition.dataEpoch,
      (BigInt(first.sourcePosition.sequence) - 1n).toString());
    expect(batch?.sequence).toBe(first.sourcePosition.sequence);
    expect(batch?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(fuseki, batch!, batch!.eventIds[0]!);
    expect(event).toMatchObject({ type: 'com.rezics.source.projected.v1',
      data: { receipt: { id: first.receipt, action: 'source.project', outcome: 'succeeded',
        record: first.record, conversion: first.conversion, byteDigest: first.sourceDigest } } });
    expect(await (await call('owner', conversionId, 'POST')).json()).toEqual(first);
    expect(await (await call('read-only', conversionId, 'GET')).json()).toEqual(first);
    expect((await call('other', conversionId, 'GET')).status).toBe(404);
    const proposed = await propose('owner', conversionId);
    expect(proposed.status).toBe(201);
    const proposalWrite = await proposed.json() as { replayed: boolean; proposal: {
      proposal: string; state: string; target: string; candidateTitle: string;
      rightsEvidence: { basis: string; note: string }; rightsStatus: string;
      sourceOnlyFields: string[]; semanticTypes: string[]; graphReceipt: string;
      graphPosition: { dataEpoch: string; sequence: string }; record: string;
      observation: string; conversion: string; sourceDigest: string } };
    expect(proposalWrite).toMatchObject({ replayed: false, proposal: {
      state: 'proposed', target: 'new-native-work', record: first.record,
      observation: first.observation, conversion: first.conversion,
      sourceDigest: first.sourceDigest, candidateTitle: 'Source "Work"',
      semanticTypes: [], sourceOnlyFields: ['description', 'authors', 'subjects'],
      rightsEvidence: { basis: 'unknown', note: 'Scope still under review' },
      rightsStatus: 'undetermined', graphReceipt: first.receipt,
      graphPosition: first.sourcePosition } });
    const proposalId = proposalWrite.proposal.proposal.split('/').at(-1)!;
    expect((await (await propose('owner', conversionId)).json())).toEqual({
      ...proposalWrite, replayed: true });
    expect((await (await readProposal('read-only', proposalId)).json()))
      .toEqual(proposalWrite.proposal);
    expect((await readProposal('other', proposalId)).status).toBe(404);
    expect((await contentPool.query('SELECT id FROM source.native_work_proposal WHERE principal_id = $1',
      [ownerId])).rowCount).toBe(1);
    await expect(contentPool.query(`UPDATE source.native_work_proposal SET candidate_title = 'Changed'
      WHERE id = $1`, [proposalId])).rejects.toThrow();
    const longWorkId = 'OL45805W';
    const longBytes = Buffer.from(JSON.stringify({ key: `/works/${longWorkId}`,
      type: { key: '/type/work' }, title: 'T'.repeat(201) }));
    const longObservation = await intake.submit(ownerId, `source-long-title-${randomUUID()}`, {
      provider: 'open-library', namespace: 'work', externalId: longWorkId,
      sourceRevision: null, mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: longBytes.toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' },
    }, { profile: 'open-library-work-acquisition-v1',
      url: `https://openlibrary.org/works/${longWorkId}.json`, status: 200,
      etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const longConversion = await conversions.convert(ownerId,
      longObservation.observation.observation.split('/').at(-1)!);
    const longConversionId = longConversion!.conversion.conversion.split('/').at(-1)!;
    expect(await sourceGraph.project(ownerId, longConversionId)).not.toBeNull();
    expect((await propose('owner', longConversionId)).status).toBe(422);
    expect((await contentPool.query('SELECT id FROM source.native_work_proposal WHERE principal_id = $1',
      [ownerId])).rowCount).toBe(1);
    const source = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:source> { <${first.conversion}> a rv:SourceConversion ;
        rv:sourceTitle "Source \\"Work\\"" ; rv:sourceDescription "Private\\nsource expression" . }
    }`);
    expect(source.boolean).toBe(true);
    const native = await fuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
      <${observed.observation.record}> a <https://schema.org/CreativeWork> . } }`);
    expect(native.boolean).toBe(false);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
    expect((await call('owner', conversionId, 'GET')).status).toBe(403);
    expect((await call('owner', conversionId, 'POST')).status).toBe(403);
    expect((await propose('owner', conversionId)).status).toBe(403);
    expect((await readProposal('owner', proposalId)).status).toBe(403);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
