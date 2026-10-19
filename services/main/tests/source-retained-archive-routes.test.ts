import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario, setFixtureMandateState } from '../src/modules/access/fixture-authority-scenario.ts';
import { SourceIntakeStore, type StagedSourceObservation } from '../src/modules/source/intake.ts';
import { SourceArchiveEvidenceOwner, type RetainedArchiveAdmission,
  type RetainedArchiveInput } from '../src/modules/source/archive-evidence.ts';
import { RightsStore } from '../src/modules/rights/store.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { sourceRoutes } from '../src/routes/sources.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { retainedEvidenceFixture, evidenceDigest as sha } from './support/retained-evidence-fixture.ts';
import { retainedTar } from './support/source-archive-fixture.ts';

let fixture: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
let intake: SourceIntakeStore, archives: SourceArchiveEvidenceOwner, access: AccessAdmissionRegistry;
beforeAll(async () => {
  fixture = await retainedEvidenceFixture('source_archive_routes');
  access = new AccessAdmissionRegistry(fixture.accessPool);
  const rights = new RightsStore(fixture.pool,fixture.accessPool);
  intake = new SourceIntakeStore(fixture.pool);
  intake.setRawRetentionGate((provider,namespace) => rights.rawRetentionPermitted(provider,namespace));
  archives = new SourceArchiveEvidenceOwner(fixture.pool,intake,access,rights,fixture.objects);
},120_000);
afterAll(async () => { await fixture?.close(); });
const authority = () => fixtureAuthorityScenario(fixture.pool,
  { scope: 'work:create:root',action: 'work.create',mandate: 'work.create' });

function client(principal: VerifiedPrincipal, actor: string) {
  // Actual routes, Source SQL, Access and Rights owners; Account token
  // verification and immutable object transport are controlled ports.
  const app = new Elysia().use(sourceRoutes({ sourceIntake: intake,sourceArchives: archives,access,
    account: { verify: async (request: Request,scopes: string[]) => {
      expect(scopes).toEqual([new URL(request.url).pathname.endsWith('/image-witness') ? 'source:read' : 'source:intake']);
      return principal;
    } },actingContexts: { discover: async () => ({ contexts: [{ actingSubject: actor }],directContexts: [] }) },
  } as unknown as MainWorkDependencies));
  return (path: string, body: object, key?: string) => app.handle(new Request(`http://source.test${path}`,{
    method: 'POST',headers: { authorization: 'Bearer owner-fixture','content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}) },body: JSON.stringify(body),
  }));
}
function input(bytes: Uint8Array, mediaType = 'application/octet-stream') {
  return { profile: 'source-manual-intake-v1',provider: 'vndb',namespace: 'archive',externalId: 'frozen-dump',
    sourceRevision: 'frozen-shape',mediaType,retention: 'retained',rawBytesBase64: Buffer.from(bytes).toString('base64'),
    coverage: { scope: 'original-archive-part',complete: false,omittedFields: [] },
    rightsEvidence: { basis: 'unknown',note: '' } };
}
async function captured(post: ReturnType<typeof client>, bytes: Uint8Array): Promise<StagedSourceObservation> {
  const result = await post('/v1/sources/intakes',input(bytes),randomUUID());
  expect(result.status).toBe(201);
  return (await result.json() as { observation: StagedSourceObservation }).observation;
}
const row = { id: 'c13',image: 'ch41',name: 'Exact retained row' };
const coordinate = { table: 'chars',rowOrdinal: 0,rowDigest: sha(JSON.stringify(row)),fieldLocator: '/image',
  imageId: 'ch41',namespace: 'character',externalId: 'c13',role: 'portrait' };
async function manifest(post: ReturnType<typeof client>): Promise<RetainedArchiveInput> {
  const bytes = retainedTar([['db/chars.header','id\timage\tname\n'],
    ['db/chars','c13\tch41\tExact retained row\nc13\tch41\tExact retained row\n']]);
  const first = await captured(post,bytes.subarray(0,700)), second = await captured(post,bytes.subarray(700));
  return { profile: 'source-retained-archive-v1',record: first.record,observation: first.observation,
    observationDigest: first.byteDigest!,archiveDigest: sha(bytes),byteLength: bytes.length,mediaType: 'application/x-tar',
    parts: [first,second].map((part,index) => ({ index,record: part.record,observation: part.observation,byteDigest: part.byteDigest! })) };
}

test('Source HTTP intake admits the owner binary-part limit while preserving the other manual-source limit',async () => {
  const a = await authority(), post = client(a.principal,a.actor);
  const bytes = Buffer.alloc(262_144,7), capture = await captured(post,bytes);
  expect(capture.byteLength).toBe(bytes.length); expect(capture.byteDigest).toBe(sha(bytes));
  expect(Buffer.from(capture.rawBytesBase64!,'base64')).toEqual(bytes);
  const json = await post('/v1/sources/intakes',input(Buffer.alloc(65_537,32),'application/json'),randomUUID());
  expect(json.status).toBe(400);
  const tooLarge = await post('/v1/sources/intakes',input(Buffer.alloc(262_145)),randomUUID());
  expect(tooLarge.status).toBe(400);
});

test('Source HTTP archive admission and exact COPY witness use real ordered custody without a converter run',async () => {
  const a = await authority(), post = client(a.principal,a.actor), retained = await manifest(post), key = randomUUID();
  const body = { ...retained,actingSubject: a.actor };
  const admitted = await post('/v1/sources/archives',body,key);
  expect(admitted.status).toBe(201); expect(admitted.headers.get('cache-control')).toBe('no-store');
  const settled = await admitted.json() as { admission: RetainedArchiveAdmission; replayed: boolean };
  expect(settled.admission).toMatchObject(retained); expect(settled.replayed).toBe(false);
  const replay = await post('/v1/sources/archives',body,key);
  expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...settled,replayed: true });
  const path = `/v1/sources/archives/${settled.admission.admission.slice(-36)}/image-witness`;
  for (const rowOrdinal of [0,1]) {
    const result = await post(path,{ ...coordinate,rowOrdinal });
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    const witness = await result.json() as { archive: RetainedArchiveAdmission;
      row: { rowOrdinal: number; rowDigest: string; decodedBytesBase64: string; decodedRow: object } };
    expect(witness.archive).toEqual(settled.admission); expect(witness.row.rowOrdinal).toBe(rowOrdinal);
    expect(witness.row.rowDigest).toBe(coordinate.rowDigest); expect(witness.row.decodedRow).toEqual(row);
    expect(sha(Buffer.from(witness.row.decodedBytesBase64,'base64'))).toBe(coordinate.rowDigest);
    expect(witness.row).not.toHaveProperty('decodedBytes');
  }
  expect((await post(path,{ ...coordinate,rowDigest: 'a'.repeat(64) })).status).toBe(409);
  expect((await post('/v1/sources/archives',{ ...body,archiveDigest: 'b'.repeat(64) },key)).status).toBe(409);
  expect((await fixture.pool.query('SELECT count(*)::integer AS n FROM source.conversion')).rows[0].n).toBe(0);
});

test('Source HTTP archive reads and retries recheck custody and actual authority without exposing foreign parts',async () => {
  const a = await authority(), post = client(a.principal,a.actor), retained = await manifest(post), key = randomUUID();
  const body = { ...retained,actingSubject: a.actor };
  const admitted = await post('/v1/sources/archives',body,key);
  expect(admitted.status).toBe(201);
  const settled = await admitted.json() as { admission: RetainedArchiveAdmission };
  const path = `/v1/sources/archives/${settled.admission.admission.slice(-36)}/image-witness`;
  const other = await authority(), foreign = client(other.principal,other.actor);
  const hidden = await foreign(path,coordinate);
  const absent = await foreign(`/v1/sources/archives/${randomUUID()}/image-witness`,coordinate);
  expect(hidden.status).toBe(503); expect(absent.status).toBe(hidden.status);
  expect(await hidden.json()).toEqual(await absent.json());
  expect([...hidden.headers]).toEqual([...absent.headers]);
  await new VerificationStore(fixture.pool).recordObservationDisposition(a.principalId,randomUUID(),
    retained.parts[1]!.observation.slice(-36),{ expectedHead: null,state: 'withdrawn',reason: 'Withdraw retained byte part' });
  expect((await post(path,coordinate)).status).toBe(503);
  await setFixtureMandateState(fixture.pool,a.representationId,'revoked');
  expect((await post('/v1/sources/archives',body,key)).status).toBe(403);
});
