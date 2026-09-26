import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessDownloadLeases } from '../../../services/main/src/modules/access/download-leases.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { AccessVotes } from '../../../services/main/src/modules/vote/access.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import type { MediaDependencies } from '../../../services/main/src/modules/media/commands.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

const root = resolve(import.meta.dir, '../../..');
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** A PNG signature and IHDR with the given size, followed by opaque payload bytes. */
export function png(width: number, height: number, payload = 64): Uint8Array {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 6, 0, 0, 0], 24);
  return new Uint8Array(Buffer.concat([header, randomBytes(payload)]));
}

/** Counts Main-to-Fuseki queries so tests can assert fixed per-batch graph round trips. */
class CountingFuseki extends FusekiClient {
  queries = 0;
  override async query(sparql: string, maxBytes?: number): Promise<SparqlResult> {
    this.queries++;
    return super.query(sparql, maxBytes);
  }
}

class CountingMediaAccess extends MediaAccessBatchReader {
  batches = 0;
  override async canReadWorks(principal: VerifiedPrincipal, actingSubject: string, works: readonly string[]) {
    this.batches++;
    return super.canReadWorks(principal, actingSubject, works);
  }
}

export type MediaStack = Awaited<ReturnType<typeof startMediaStack>>;

/** Real Access, Content PostgreSQL, Jena and RustFS behind one Main app; Account is a
 * bearer-to-principal table so several isolated members can act concurrently. */
export async function startMediaStack(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.MAIN_S3_ENDPOINT) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fuseki = new CountingFuseki(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  const store = new MediaStore(contentPool, content);
  const objects = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await objects('media/').initialize();
  const media: MediaDependencies = { store, content, objects };
  const access = new AccessAdmissionRegistry(accessPool);
  const downloadLeases = new AccessDownloadLeases(accessPool);
  const accessPolicy = new AccessPolicyOwner(accessPool);
  const issuer = `https://qa-${label}.test`;
  const tokens = new Map<string, { issuer: string; subject: string }>();
  const mediaAccess = new CountingMediaAccess(accessPool);
  const votes = new AccessVotes(accessPool);
  const erasures = new ErasureService(relayPool, contentPool);
  const main = createMainApp(fuseki, { environment: env, access, downloadLeases, accessPolicy,
    content, contentAuthoring: content, media, votes, erasures,
    mediaAccess,
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const principal = tokens.get(token);
      if (!principal) throw new Error('unknown QA bearer');
      return principal;
    } } });

  const call = (method: string, path: string, options: { token?: string; body?: unknown; key?: string;
    raw?: Uint8Array } = {}) => main.handle(new Request(`http://main.local${path}`, { method,
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.raw ? { body: new Blob([new Uint8Array(options.raw)]) } : {}) }));

  /** One Account principal, represented Agent and bearer token; grants are explicit per scope. */
  const member = async (name: string) => {
    const principalId = randomUUID();
    const principal = { issuer, subject: `${name}-${randomUUID()}` };
    const actor = `${ID}${randomUUID()}`;
    const token = randomUUID();
    tokens.set(token, principal);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const grant = async (scope: string, action: string) => {
      const client = await accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const send = (method: string, path: string, body?: unknown, key = `${name}-${randomUUID()}`) =>
      call(method, path, { token, body, key });
    const read = (path: string) => {
      const url = new URL(`http://main.local${path}`);
      url.searchParams.set('actingSubject', actor);
      return call('GET', `${url.pathname}${url.search}`, { token });
    };
    /** Reserve, transfer and activate one public or private image through the API. */
    const upload = async (bytes: Uint8Array, disclosure: 'public' | 'private' = 'public', asset: string | null = null) => {
      const reserved = await send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset,
        mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure, actingSubject: actor });
      if (reserved.status !== 201) throw new Error(`reserve: ${reserved.status} ${await reserved.text()}`);
      const reservation = await reserved.json() as { asset: string; upload: string; stateHead: string };
      const activated = await call('PUT', `/v1/media/uploads/${reservation.upload}/bytes`, { token, raw: bytes });
      if (activated.status !== 201) throw new Error(`activate: ${activated.status} ${await activated.text()}`);
      return { ...reservation, ...await activated.json() as { representation: string; revision: string } };
    };
    await grant(`media:owner:${actor}`, 'media.upload');
    await grant(`media:owner:${actor}`, 'media.manage');
    return { name, actor, token, principal, principalId, grant, send, read, upload };
  };

  const admission = (actor: string, scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `${label}-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false };
  };
  /** A metadata-only Work: no Main selection, so it is never public. */
  const privateWork = async (actor: string, title = `${label} private ${randomUUID()}`) => {
    const created = await activateMetadataWork(env, { title,
      admission: admission(actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    return { work: created.work, mainVersion: created.mainVersion, title };
  };
  const contribution = async (work: string, actor: string, language: string, body: string) => {
    const draftInput = { work, language, body, actingSubject: actor };
    const draft = await activateTextContribution(env, admission(actor, `contribution:create:${work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) throw new Error('draft failed');
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const publication = await publishTextContribution(env, admission(actor,
      `contribution:publish:${draft.contribution}`, 'contribution.publish', textPublicationDigest(publishInput)),
    publishInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) throw new Error('publish failed');
    return { contribution: draft.contribution, decision: publication.publicationDecision, language };
  };
  /** A Work whose Main Version selects a public native contribution; further languages stay eligible variants. */
  const publicWork = async (actor: string, languages: string[] = ['en'], title = `${label} public ${randomUUID()}`) => {
    const created = await privateWork(actor, title);
    const variants = [];
    for (const language of languages) {
      variants.push(await contribution(created.work, actor, language, `${label} ${language} ${randomUUID()}`));
    }
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: variants[0]!.contribution, publicationDecision: variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await selectMainDefault(env, admission(actor, `publication:select:${created.mainVersion}`,
      'publication.select', mainSelectionDigest(input)), input);
    if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
    return { ...created, variants };
  };

  const stop = async () => {
    await Promise.all([accessPool.end(), contentPool.end(), relayPool.end()]);
    rmSync(directory, { recursive: true, force: true });
  };
  return { env, fuseki, main, call, member, access, mediaAccess, accessPool, contentPool, content, store, objects,
    media, admission, privateWork, publicWork, contribution, stop };
}
