import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OpenLibraryConversionStore, SourceConversionInvalid }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph, sourceProjectionIdentity }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { sourceFieldClaims } from '../../../services/main/src/modules/source/reification.ts';

test('MODEL09: source field Statements retain exact observation provenance without native acceptance', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const issuer = 'https://qa-source-reification.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const intake = new SourceIntakeStore(contentPool);
  const conversions = new OpenLibraryConversionStore(contentPool, intake);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  const sourceGraph = new OpenLibrarySourceGraph(fuseki, lineage, conversions);
  const app = createMainApp(fuseki, {
    environment: { fuseki, lineage, objectDirectory: '.temp/source-reification-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer owner' && ['source:convert', 'source:read'].includes(required[0]!)) return owner;
      if (token === 'Bearer other' && required[0] === 'source:convert') return other;
      throw new AccountAssertionDenied('scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool), sourceIntake: intake,
    sourceConversions: conversions, sourceGraph,
  });
  const project = (token: string, conversion: string) => app.handle(new Request(
    `http://main.local/v1/sources/conversions/${conversion}/source-graph`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'source-open-library-work-v1' }),
    }));
  const submit = async (workId: string, description: string | null, complete = true) => {
    const body: Record<string, unknown> = { key: `/works/${workId}`,
      type: { key: '/type/work' }, title: 'Observed title' };
    if (description !== null) body.description = { value: description };
    const bytes = Buffer.from(JSON.stringify(body));
    return intake.submit(ownerId, `source-reification-${randomUUID()}`, {
      provider: 'open-library', namespace: 'work', externalId: workId,
      sourceRevision: 'open-library-revision:9', mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' },
    }, { profile: 'open-library-work-acquisition-v1',
      url: `https://openlibrary.org/works/${workId}.json`, status: 200,
      etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
  };
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`, [ownerId, issuer, owner.subject, otherId, other.subject]);
    const workId = 'OL45809W';
    const observed = await submit(workId, 'Observed description');
    const observationId = observed.observation.observation.split('/').at(-1)!;
    const converted = await conversions.convert(ownerId, observationId);
    if (!converted) throw new Error('complete source conversion missing');
    const conversionId = converted.conversion.conversion.split('/').at(-1)!;
    const staleGraph = new OpenLibrarySourceGraph(fuseki,
      { dataEpoch: randomUUID(), routingEpoch: lineage.routingEpoch }, conversions);
    await expect(staleGraph.project(ownerId, conversionId)).rejects.toThrow();
    const receipt = sourceProjectionIdentity(converted.conversion).receipt;
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:receipts> {
      <${receipt}> ?p ?o . } }`)).boolean).toBe(false);
    expect((await project('denied', conversionId)).status).toBe(401);
    expect((await project('other', conversionId)).status).toBe(404);

    const incomplete = await submit('OL45810W', 'Incomplete', false);
    await expect(conversions.convert(ownerId,
      incomplete.observation.observation.split('/').at(-1)!)).rejects.toBeInstanceOf(SourceConversionInvalid);

    const [firstResponse, replayResponse] = await Promise.all([
      project('owner', conversionId), project('owner', conversionId),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    const first = await firstResponse.json() as { receipt: string; conversion: string;
      observation: string; sourceDigest: string; sourcePosition: { sequence: string } };
    expect(await replayResponse.json()).toEqual(first);
    expect(first).toMatchObject({ conversion: converted.conversion.conversion,
      observation: observed.observation.observation, sourceDigest: observed.observation.byteDigest });
    const claims = sourceFieldClaims(converted.conversion, observed.observation);
    expect(claims.map(claim => claim.field)).toEqual(['title', 'description']);
    const query = await fuseki.query(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX prov: <http://www.w3.org/ns/prov#> PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?statement ?predicate ?object ?derived ?field ?digest WHERE {
        GRAPH <urn:rezics:graph:source> {
          <${first.conversion}> rv:sourceStatement ?statement .
          ?statement a rdf:Statement ; rdf:subject <${first.conversion}> ;
            rdf:predicate ?predicate ; rdf:object ?object ; prov:wasDerivedFrom ?derived ;
            rv:sourceObservation <${first.observation}> ; rv:sourceByteDigest ?digest ;
            rv:sourceMappingRevision "open-library-work-map-v1" ;
            rv:fieldDisposition "structured-source-only" ; rv:sourceField ?field .
        }
      } ORDER BY ?field`, 16_384);
    const rows = query.results?.bindings ?? [];
    expect(rows.map(row => row.field?.value)).toEqual(['description', 'title']);
    expect(rows.map(row => row.object?.value)).toEqual(['Observed description', 'Observed title']);
    expect(rows.every(row => row.derived?.value === first.observation
      && row.digest?.value === first.sourceDigest)).toBe(true);
    expect(new Set(rows.map(row => row.statement?.value))).toEqual(new Set(claims.map(item => item.id)));
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(*) AS ?count) WHERE { GRAPH <urn:rezics:graph:source> {
        <${first.conversion}> rv:sourceStatement ?statement . ?statement ?p ?o . } }`))
      .results?.bindings?.[0]?.count?.value).toBe('22');
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(*) AS ?count) WHERE { GRAPH <urn:rezics:graph:source> {
        <${first.conversion}> rv:sourceStatement ?statement . } }`))
      .results?.bindings?.[0]?.count?.value).toBe('2');
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
      <${first.conversion}> ?p ?o . } }`)).boolean).toBe(false);
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
      <https://openlibrary.org/works/${workId}> <https://schema.org/name> ?name . } }`)).boolean).toBe(false);
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:graph:source> {
      <${first.conversion}> <https://schema.org/name> ?name . } }`)).boolean).toBe(false);
    expect((await fuseki.query(`SELECT (COUNT(*) AS ?count) WHERE {
      GRAPH <urn:rezics:graph:receipts> { ?receipt a <https://rezics.com/vocab/OperationReceipt> ;
        <https://rezics.com/vocab/sourceConversion> <${first.conversion}> . }
    }`)).results?.bindings?.[0]?.count?.value).toBe('1');

    const titleOnlyObserved = await submit('OL45811W', null);
    const titleOnlyConversion = await conversions.convert(ownerId,
      titleOnlyObserved.observation.observation.split('/').at(-1)!);
    if (!titleOnlyConversion) throw new Error('title-only source conversion missing');
    const titleOnlyClaims = sourceFieldClaims(titleOnlyConversion.conversion, titleOnlyObserved.observation);
    expect(titleOnlyClaims.map(claim => claim.field)).toEqual(['title']);
    const titleOnlyId = titleOnlyConversion.conversion.conversion.split('/').at(-1)!;
    expect((await project('owner', titleOnlyId)).status).toBe(200);
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(*) AS ?count) WHERE { GRAPH <urn:rezics:graph:source> {
        <${titleOnlyConversion.conversion.conversion}> rv:sourceStatement ?statement . } }`))
      .results?.bindings?.[0]?.count?.value).toBe('1');
  } finally {
    await contentPool.end();
    await accessPool.end();
  }
});
