import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { CountingPool, isForegroundOperation } from './support/operation-cost.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { attributeDirectoryRefreshQueries, CountingFuseki } from './support/counting-fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccessDownloadLeases } from '../../../services/main/src/modules/access/download-leases.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { PrivateContextSelections } from '../../../services/main/src/modules/context/private-selection.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import { AccessManagedOrganizations } from '../../../services/main/src/modules/access/managed-organizations.ts';
import { AccessVotes } from '../../../services/main/src/modules/vote/access.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import type { MediaDependencies } from '../../../services/main/src/modules/media/commands.ts';
import { MediaScreenStore } from '../../../services/main/src/modules/media-screen/store.ts';
import { screenVerdict } from '../../../services/main/src/modules/media-screen/policy.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { activateMetadataWork, GRAPHS, ID, RV, iri, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { TemplateSeekIndex } from '../../../services/main/src/modules/query/seek-index.ts';
import { requiredMatcherMode, requiredSafetyMatcher } from '../../../services/main/src/modules/media-screen/required-matcher.ts';
import { readUuid } from '../../../services/main/src/modules/work/read-contract.ts';

const root = resolve(import.meta.dir, '../../..');
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Deterministic UUID for a fixture identity that must survive a second run on the same database. */
function fixtureUuid(name: string): string {
  const hex = createHash('sha256').update(`rezics-fixture:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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

class CountingMediaAccess extends MediaAccessBatchReader {
  batches = 0;
  override async canReadWorks(principal: VerifiedPrincipal, actingSubject: string, works: readonly string[]) {
    if (isForegroundOperation()) this.batches++;
    return super.canReadWorks(principal, actingSubject, works);
  }
}

export type MediaStack = Awaited<ReturnType<typeof startMediaStack>>;

/** Real Access, Content PostgreSQL, Jena and RustFS behind one Main app; Account is a
 * bearer-to-principal table so several isolated members can act concurrently. */
export async function startMediaStack(label: string, options: { contentProjection?: boolean; profileCredits?: boolean;
  autoClearUploads?: boolean; agents?: boolean; rights?: boolean; library?: boolean;
  matcherMode?: string;
  matchUploads?: boolean;
  ownerUrls?: { access: string; content: string; relay: string } } = {}) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.MAIN_S3_ENDPOINT || !Bun.env.MAIN_OBJECT_DIRECTORY) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fuseki = new CountingFuseki(Bun.env.FUSEKI_URL);
  attributeDirectoryRefreshQueries();
  // The graph is shared by the shard, so immutable manifests must survive this
  // fixture too. The runner removes both owners when it resets the QA stack.
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
  const accessPool = new CountingPool({ connectionString: options.ownerUrls?.access ?? Bun.env.ACCESS_DATABASE_URL });
  env.addresses = new AliasRegistry(accessPool);
  const contentPool = new CountingPool({ connectionString: options.ownerUrls?.content ?? Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new CountingPool({ connectionString: options.ownerUrls?.relay ?? Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  const contentCursor = new ContentProjectionCursor(contentPool);
  const contentConsumer = `${label}-content-public-search-v1`;
  const matcherMode = requiredMatcherMode(options.matcherMode);
  const store = new MediaStore(contentPool, content, matcherMode);
  const objects = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await objects('media/').initialize();
  const media: MediaDependencies = { store, content, objects,
    matcher: options.matchUploads === false ? undefined : requiredSafetyMatcher(matcherMode) };
  const access = new AccessAdmissionRegistry(accessPool);
  access.configureBaseline(fuseki);
  const grants = new AccessGrants(accessPool);
  const actingContexts = new AccessActingContexts(accessPool);
  const managedOrganizations = new AccessManagedOrganizations(accessPool);
  const downloadLeases = new AccessDownloadLeases(accessPool);
  const accessPolicy = new AccessPolicyOwner(accessPool);
  const issuer = `https://qa-${label}.test`;
  const tokens = new Map<string, { issuer: string; subject: string }>();
  const mediaAccess = new CountingMediaAccess(accessPool);
  const votes = new AccessVotes(accessPool);
  const contextSelections = new PrivateContextSelections(accessPool);
  const erasures = new ErasureService(relayPool, contentPool, accessPool);
  const statementSeek = new StatementSeek(accessPool,env);
  const templateSeek = new TemplateSeekIndex(accessPool,fuseki);
  await templateSeek.backfill(env.lineage.dataEpoch);
  // Closed routes refuse every caller when this is absent, before any grant is read.
  // The running Main carries the same exposure, so a fixture principal's grant is visible here.
  const main = createMainApp(fuseki, { environment: env, access, grants, downloadLeases, accessPolicy,
    platformAccess: new AccessExposure(accessPool),
    statementSeek, templateSeek,
    content, contentAuthoring: content, media, votes, erasures,
    ...(options.profileCredits ? { profiles: new ProfilesAccess(accessPool), personPreferences: new PersonPreferencesStore(accessPool) } : {}),
    ...(options.contentProjection ? { contentProjection: { content, cursor: contentCursor,
      consumer: contentConsumer } } : {}),
    mediaAccess, actingContexts, managedOrganizations, contextSelections, projections: new ProjectionStore(accessPool),
    ...(options.agents ? { agentProvisioning: new AgentProvisioning(accessPool, env) } : {}),
    ...(options.library ? { libraryStatus: new ReaderLibraryStatusStore(contentPool),
      profiles: new ProfilesAccess(accessPool), personPreferences: new PersonPreferencesStore(accessPool),
      libraryRatings: new ReaderLibraryRatings(accessPool) } : {}),
    ...(options.rights ? { rights: { store: new RightsStore(contentPool, accessPool) } } : {}),
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const principal = tokens.get(token);
      if (!principal) throw new Error('unknown QA bearer');
      if (!options.library) return principal;
      // A baseline member claim re-reads the Account assertion. The library
      // flag is that verified reader, so the re-read stays the same principal.
      const verified = { ...principal, emailVerified: true as const };
      return { ...verified, currentAssertion: async () => verified };
    } } });

  // Existing media journeys use an explicitly deterministic benign screen.
  // Screening acceptance disables this fixture convenience to observe every state.
  const autoClearUploads = options.autoClearUploads ?? true;
  const screenStore = new MediaScreenStore(contentPool);
  const call = async (method: string, path: string, options: { token?: string; body?: unknown; key?: string;
    raw?: Uint8Array } = {}) => {
    const response = await main.handle(new Request(`http://main.local${path}`, { method,
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.raw ? { body: new Blob([new Uint8Array(options.raw)]) } : {}) }));
    if (autoClearUploads && method === 'PUT' && /^\/v1\/media\/uploads\/[^/]+\/bytes$/.test(path)
      && response.status < 300) {
      for (let i = 0; i < 100; i++) {
        const lease = await screenStore.leaseNext();
        if (!lease) break;
        await screenStore.settle(lease, screenVerdict({ Drawing: 0.05, Hentai: 0.01, Neutral: 0.9, Porn: 0.01, Sexy: 0.03 }));
      }
    }
    return response;
  };

  /** One Account principal, represented Agent and bearer token; grants are explicit per scope.
   * `stable` keeps the same issuer, subject and Agent across processes so a later run replays
   * instead of claiming a handle the first run already owns. */
  const member = async (name: string, memberOptions?: { stable?: boolean }) => {
    const stable = memberOptions?.stable === true;
    const principal = stable
      ? { issuer: 'https://qa-wiki-fixture.test', subject: name }
      : { issuer, subject: `${name}-${randomUUID()}` };
    const actor = stable ? `${ID}${fixtureUuid(`actor:${name}`)}` : `${ID}${randomUUID()}`;
    const token = randomUUID();
    tokens.set(token, principal);
    const existing = stable ? await accessPool.query<{ id: string }>(
      `SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2 AND active`,
      [principal.issuer, principal.subject]) : { rows: [] as { id: string }[] };
    const principalId = existing.rows[0]?.id ?? (stable ? fixtureUuid(`principal:${name}`) : randomUUID());
    if (!existing.rows[0]) await accessPool.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query(stable
      ? "INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent') ON CONFLICT (id) DO NOTHING"
      : "INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    if (options.profileCredits) await createAgentGraph(env, {
      id: randomUUID(), agent: actor, kind: 'person', displayName: name, digest: sha(actor),
    });
    const grant = async (scope: string, action: string) => {
      if (stable) {
        const held = await accessPool.query<{ id: string }>(`SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()
          LIMIT 1`, [actor, scope, action]);
        // A reused fixture grant can enter an HTTP request, so admit its owner
        // value through the same UUID contract as a client-supplied grant id.
        if (held.rows[0]) return Value.Parse(readUuid, held.rows[0].id);
      }
      const grantId = randomUUID();
      const client = await accessPool.connect();
      // Controller mandates are rejected unless they are open-ended.
      const openEnded = action === 'agent.control';
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,CASE WHEN $5 THEN 'infinity'::timestamptz ELSE now() + interval '1 hour' END)`,
          [randomUUID(), principalId, actor, action, openEnded]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,CASE WHEN $5 THEN 'infinity'::timestamptz ELSE now() + interval '1 hour' END)`,
          [grantId, actor, scope, action, openEnded]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return grantId;
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
  /** The same admission id on a later run replays the graph receipt instead of writing another resource. */
  const stableAdmission = (actor: string, scope: string, action: string, requestDigest: string,
    name: string): RegisteredAdmission => ({
    id: fixtureUuid(`admission:${name}`), principalId: fixtureUuid(`admission-principal:${name}`),
    actingSubject: actor, scope, action, idempotencyKey: `fixture:${name}`, requestDigest,
    authorityEpoch: '0', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), state: 'claimed',
    dispatchEligible: true, replayed: false,
  });
  /** Catalogue metadata carries no invented native authorship or publication. */
  const catalogueWork = async (actor: string, title: string) => {
    const created = await activateMetadataWork(env, { title, language: 'en',
      admission: admission(actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, undefined, 'en')) });
    return { work: created.work, mainVersion: created.mainVersion, title };
  };
  /** A native author draft stays private until its Main selection is public. */
  const privateWork = async (actor: string, title = `${label} private ${randomUUID()}`) => {
    if (!(await fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(actor)} a <${RV}Agent> ; <${RV}head> ?head } }`)).boolean) {
      await provisionFixtureAuthor(env, actor);
    }
    const created = await activateMetadataWork(env, { title, language: 'en', authorAgent: actor,
      admission: admission(actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, undefined, 'en', { authorAgent: actor })) });
    return { work: created.work, mainVersion: created.mainVersion, title };
  };
  const contribution = async (work: string, actor: string, language: string, body: string, stableName?: string) => {
    const draftInput = { work, language, body, actingSubject: actor };
    const admit = (scope: string, action: string, digest: string, part: string) => stableName
      ? stableAdmission(actor, scope, action, digest, `${stableName}:${part}`)
      : admission(actor, scope, action, digest);
    const draft = await activateTextContribution(env, admit(`contribution:create:${work}`,
      'contribution.create', textContributionDigest(draftInput), 'draft'), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) throw new Error('draft failed');
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const publication = await publishTextContribution(env, admit(
      `contribution:publish:${draft.contribution}`, 'contribution.publish', textPublicationDigest(publishInput), 'publish'),
    publishInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) throw new Error('publish failed');
    return { contribution: draft.contribution, decision: publication.publicationDecision, language };
  };
  /** A Work whose Main Version selects a public native contribution; further languages stay eligible variants. */
  const publicWork = async (actor: string, languages: string[] = ['en'], title = `${label} public ${randomUUID()}`) => {
    const created = await catalogueWork(actor, title);
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
    await templateSeek.stopRecovery();
    await Promise.all([accessPool.end(), contentPool.end(), relayPool.end()]);
    rmSync(directory, { recursive: true, force: true });
  };
  return { env, fuseki, main, call, member, stableAdmission, access, mediaAccess, accessPool, contentPool, content,
    statementSeek, templateSeek,
    contentCursor, contentConsumer, store, objects,
    media, admission, catalogueWork, privateWork, publicWork, contribution, stop };
}
