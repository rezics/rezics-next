import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';

test('LIVE01/LIVE02/LIVE13/LIVE16: private manual source intake stages exact evidence without adoption', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const issuer = 'https://qa-source-intake.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const account = { verify: async (request: Request, required: readonly string[]) => {
    const token = request.headers.get('authorization');
    if (token === 'Bearer owner' && ['source:intake', 'source:read'].includes(required[0]!)) return owner;
    if (token === 'Bearer other' && required[0] === 'source:read') return other;
    throw new AccountAssertionDenied('scope is unavailable');
  } };
  const app = createMainApp(new FusekiClient(Bun.env.FUSEKI_URL), {
    environment: { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/source-intake-unused' },
    account, access: new AccessAdmissionRegistry(accessPool),
    sourceIntake: new SourceIntakeStore(contentPool),
  });
  const request = (path: string, token: string, body?: unknown, key?: string) =>
    new Request(`http://main.local${path}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const raw = Buffer.from('{"title":"Same title","count":0,"unknown":null}', 'utf8');
    const base = { profile: 'source-manual-intake-v1', provider: 'example',
      namespace: 'book', externalId: `shared-${randomUUID()}`,
      sourceRevision: 'etag-1', mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: raw.toString('base64'),
      coverage: { scope: 'record-fields-v1', complete: false,
        omittedFields: ['private.summary'] },
      rightsEvidence: { basis: 'unknown', note: 'No license evidence was supplied.' } } as const;
    const key = `source-${randomUUID()}`;
    expect((await app.handle(request('/v1/sources/intakes', 'denied', base, key))).status).toBe(401);
    const firstResponse = await app.handle(request('/v1/sources/intakes', 'owner', base, key));
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { observation: {
      record: string; observation: string; byteDigest: string; rawBytesBase64: string;
      state: string; rightsEvidence: { basis: string } }; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(first.observation).toMatchObject({ state: 'staged', rawBytesBase64: raw.toString('base64'),
      byteDigest: createHash('sha256').update(raw).digest('hex'),
      rightsEvidence: { basis: 'unknown' } });
    const replay = await app.handle(request('/v1/sources/intakes', 'owner', base, key));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ observation: first.observation, replayed: true });
    expect((await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, sourceRevision: 'etag-2' }, key))).status).toBe(409);
    const changed = await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, sourceRevision: 'etag-2' }, `changed-${randomUUID()}`));
    expect(changed.status).toBe(201);
    const second = await changed.json() as { observation: { record: string; observation: string } };
    expect(second.observation.record).toBe(first.observation.record);
    expect(second.observation.observation).not.toBe(first.observation.observation);
    const otherGrain = await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, namespace: 'edition' }, `grain-${randomUUID()}`));
    expect(otherGrain.status).toBe(201);
    expect((await otherGrain.json() as { observation: { record: string } }).observation.record)
      .not.toBe(first.observation.record);
    const id = first.observation.observation.split('/').at(-1)!;
    expect(await (await app.handle(request(`/v1/sources/observations/${id}`, 'owner'))).json())
      .toEqual(first.observation);
    expect((await app.handle(request(`/v1/sources/observations/${id}`, 'other'))).status).toBe(404);
    const noRetention = { ...base, retention: 'not-retained', rawBytesBase64: undefined,
      coverage: { scope: 'api-response-v1', complete: false, omittedFields: ['raw.response'] } };
    expect((await app.handle(request('/v1/sources/intakes', 'owner',
      { ...noRetention, rawBytesBase64: raw.toString('base64') },
      `invalid-${randomUUID()}`))).status).toBe(400);
    const withheld = await app.handle(request('/v1/sources/intakes', 'owner', noRetention,
      `withheld-${randomUUID()}`));
    expect(withheld.status).toBe(201);
    const withheldBody = await withheld.json() as { observation: {
      observation: string; byteDigest: null; byteLength: null; rawBytesBase64?: string } };
    expect(withheldBody.observation.byteDigest).toBeNull();
    expect(withheldBody.observation.byteLength).toBeNull();
    expect(withheldBody.observation.rawBytesBase64).toBeUndefined();
    const stored = await contentPool.query<{ raw_bytes: Buffer | null }>(
      'SELECT raw_bytes FROM source.observation WHERE id = $1',
      [withheldBody.observation.observation.split('/').at(-1)]);
    expect(stored.rows[0]?.raw_bytes).toBeNull();
    const maximum = Buffer.alloc(65_536, 0x5a).toString('base64');
    expect((await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, rawBytesBase64: maximum }, `maximum-${randomUUID()}`))).status).toBe(201);
    expect((await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, rawBytesBase64: Buffer.alloc(65_537).toString('base64') },
      `oversize-${randomUUID()}`))).status).toBe(400);
    expect((await app.handle(request('/v1/sources/intakes', 'owner',
      { ...base, rawBytesBase64: 'a===' }, `malformed-${randomUUID()}`))).status).toBe(400);
    expect(await contentPool.query('SELECT id FROM source.observation WHERE id = $1', [id])
      .then(result => result.rowCount)).toBe(1);
    await expect(contentPool.query('UPDATE source.observation SET media_type = $2 WHERE id = $1',
      [id, 'text/plain'])).rejects.toThrow();
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
