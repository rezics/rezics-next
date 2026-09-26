import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Elysia } from 'elysia';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ProviderIdentityStore } from '../../../services/main/src/modules/source/provider-identity.ts';
import { SourceFieldWithdrawalStore } from '../../../services/main/src/modules/source/withdrawal.ts';
import { SourceScoreStore } from '../../../services/main/src/modules/source/score.ts';
import { sourceRoutes } from '../../../services/main/src/routes/sources.ts';
import { sourceSupportRoutes } from '../../../services/main/src/routes/source-supports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';

export const iri = (id: string) => `https://rezics.com/id/${id}`;
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function identityHarness() {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.FUSEKI_URL) throw new Error('Run through the isolated QA integration tier');
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 3 });
  await migrateContent(pool);
  const issuer = `https://qa-source-identity-${randomUUID()}.test`;
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const principalId = randomUUID(), otherId = randomUUID();
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3),($4,$2,$5)`, [principalId, issuer, owner.subject, otherId, other.subject]);
  const access = new AccessAdmissionRegistry(accessPool);
  const account = { verify: async (request: Request, required: readonly string[]) => {
    const token = request.headers.get('authorization');
    if (token === 'Bearer owner') return owner;
    if (token === 'Bearer other') return other;
    if (token === 'Bearer reader' && required.length === 1 && required[0] === 'source:read') return owner;
    throw new AccountAssertionDenied('scope is unavailable');
  } };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const stores = { identity: new ProviderIdentityStore(pool), withdrawal: new SourceFieldWithdrawalStore(pool),
    score: new SourceScoreStore(pool) };
  const work = { account, access, sourceProviderIdentity: stores.identity,
    sourceFieldWithdrawals: stores.withdrawal, sourceScores: stores.score } as unknown as MainWorkDependencies;
  const app = new Elysia().use(sourceRoutes(work)).use(sourceSupportRoutes(fuseki, work));
  const headers = (token: string, key?: string) => ({ authorization: `Bearer ${token}`,
    'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) });
  const post = (path: string, token: string, body: unknown, key?: string) => app.handle(
    new Request(`http://main.local${path}`, { method: 'POST', headers: headers(token, key),
      body: JSON.stringify(body) }));
  const get = (path: string, token: string) => app.handle(new Request(`http://main.local${path}`,
    { headers: headers(token) }));
  const record = async (externalId = randomUUID(), provider = 'fixture', namespace = 'work') => {
    const id = randomUUID();
    await pool.query(`INSERT INTO source.record (id, provider, namespace, external_id)
      VALUES ($1,$2,$3,$4)`, [id, provider, namespace, externalId]);
    return id;
  };
  const observation = async (recordId: string, raw: string, principal = principalId, complete = true) => {
    const id = randomUUID();
    const bytes = Buffer.from(raw);
    await pool.query(`INSERT INTO source.observation (id, record_id, principal_id, source_revision,
      media_type, retention, raw_bytes, byte_digest, coverage, rights_evidence)
      VALUES ($1,$2,$3,NULL,'application/json','retained',$4,$5,$6,'{"basis":"unknown","note":""}')`,
    [id, recordId, principal, bytes, sha(bytes), JSON.stringify({ scope: 'record', complete, omittedFields: [] })]);
    return id;
  };
  const close = async () => { await Promise.all([pool.end(), accessPool.end()]); };
  return { pool, accessPool, principalId, otherId, stores, post, get, record, observation, close };
}
