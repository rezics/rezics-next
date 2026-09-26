import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Elysia } from 'elysia';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { ProviderIdentityStore } from '../../../services/main/src/modules/source/provider-identity.ts';
import { SourceFieldWithdrawalStore } from '../../../services/main/src/modules/source/withdrawal.ts';
import { SourceScoreStore } from '../../../services/main/src/modules/source/score.ts';
import { sourceRoutes } from '../../../services/main/src/routes/sources.ts';
import { sourceRunRoutes } from '../../../services/main/src/routes/source-runs.ts';
import { sourceSupportRoutes } from '../../../services/main/src/routes/source-supports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { FixtureOpenLibrary } from './source-run-harness.ts';

export const iri = (id: string) => `https://rezics.com/id/${id}`;
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function identityHarness(options: { realAccount?: boolean;
  acquisition?: boolean | 'live' } = {}) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.FUSEKI_URL) throw new Error('Run through the isolated QA integration tier');
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 3 });
  await migrateContent(pool);
  const liveAccount = options.realAccount ? await ratingAccount(Bun.env as Record<string, string>,
    'openid work:read source:acquire source:convert source:correspond source:adopt source:read') : null;
  const issuer = liveAccount?.issuer ?? `https://qa-source-identity-${randomUUID()}.test`;
  const owner = { issuer, subject: liveAccount?.a.id ?? randomUUID() };
  const other = { issuer, subject: liveAccount?.b.id ?? randomUUID() };
  const principalId = randomUUID(), otherId = randomUUID();
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3),($4,$2,$5)`, [principalId, issuer, owner.subject, otherId, other.subject]);
  const access = new AccessAdmissionRegistry(accessPool);
  const isolatedAccount = { verify: async (request: Request, required: readonly string[]) => {
    const token = request.headers.get('authorization');
    if (token === 'Bearer owner') return owner;
    if (token === 'Bearer other') return other;
    if (token === 'Bearer reader' && required.length === 1 && required[0] === 'source:read') return owner;
    throw new AccountAssertionDenied('scope is unavailable');
  } };
  const account = liveAccount?.verifier ?? isolatedAccount;
  const tokens = liveAccount ? { owner: liveAccount.tokenA, other: liveAccount.tokenB,
    reader: liveAccount.noScope } : null;
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const provider = new FixtureOpenLibrary();
  const intake = new SourceIntakeStore(pool);
  const stores = { identity: new ProviderIdentityStore(pool), withdrawal: new SourceFieldWithdrawalStore(pool),
    score: new SourceScoreStore(pool) };
  const work = { account, access, sourceProviderIdentity: stores.identity,
    sourceFieldWithdrawals: stores.withdrawal, sourceScores: stores.score,
    ...(options.acquisition ? { sourceAcquisitions: sourceAcquisitionServices(pool,
      { fetcher: options.acquisition === 'live' ? fetch : provider.fetch,
        reserve: options.acquisition === 'live' ? () => intake.reserveOpenLibrarySlot() : async () => {} }) }
      : {}) } as unknown as MainWorkDependencies;
  const app = new Elysia().use(sourceRoutes(work)).use(sourceRunRoutes(work))
    .use(sourceSupportRoutes(fuseki, work));
  const headers = (token: string, key?: string) => ({ authorization: `Bearer ${tokens?.[token as keyof typeof tokens] ?? token}`,
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
  const close = async () => { await liveAccount?.close(); await Promise.all([pool.end(), accessPool.end()]); };
  const verifyOwner = () => account.verify(new Request('http://main.local/',
    { headers: headers('owner') }), ['work:read']);
  return { pool, accessPool, principalId, otherId, stores, post, get, record, observation,
    provider, fuseki, access, verifyOwner, close };
}
