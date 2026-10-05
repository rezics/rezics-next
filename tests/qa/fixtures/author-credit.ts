import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import {
  type FusekiClient,
  type CommandEnvelope,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { ProtectionAdmissionSigner } from '../../../services/main/src/modules/access/protection-admission.ts';
import { OpenLibraryConversionStore } from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { RecipeSourceConversionStore } from '../../../services/main/src/modules/recipe/source-conversion.ts';
import {
  SourceNativeWorkProposalStore,
  type NativeWorkSourceProposal,
} from '../../../services/main/src/modules/source/native-work-proposal.ts';
import {
  SourceNativeWorkAdoptionStore,
  type NativeWorkSourceAdoption,
} from '../../../services/main/src/modules/source/native-work-adoption.ts';
import { SourceNativeWorkAttachmentStore } from '../../../services/main/src/modules/source/native-work-attachment.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import {
  SourceAuthorCreditStore,
  type AdoptSourceAuthorCreditInput,
} from '../../../services/main/src/modules/source/author-credit.ts';
import { SourceAuthorNameStore } from '../../../services/main/src/modules/source/author-name.ts';
import { ProviderIdentityStore } from '../../../services/main/src/modules/source/provider-identity.ts';
import { SourceFieldWithdrawalStore } from '../../../services/main/src/modules/source/withdrawal.ts';
import { SourceFieldAttachmentStore } from '../../../services/main/src/modules/source/support-attach.ts';
import { SourceFieldApplicationStore } from '../../../services/main/src/modules/source/field-application.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { ownerEvidenceCapture } from '../../../services/main/src/modules/governance/evidence.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { SourceNativeChildStore } from '../../../services/main/src/modules/source/child-native-support.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { provisionFixtureAuthor } from './authored-work.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import {
  attributeDirectoryRefreshQueries,
  CountingFuseki,
} from '../integration/support/counting-fuseki.ts';

export const shortId = (uri: string) => uri.split('/').at(-1)!;
export const nativeId = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
export const author = (key: string, role: string | null = '/type/author_role') => ({
  author: { key },
  ...(role === null ? {} : { type: { key: role } }),
});

export async function authorCreditFixture(
  apps: Record<string, string>,
  objectDirectory: string,
  scopes = 'openid work:create work:edit work:read work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read',
  deletionFence?: (issuer: string, subject: string) => Promise<void>,
  options: { readingPositions?: boolean } = {},
) {
  const account = await ratingAccount(apps, scopes, deletionFence);
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  await migrateContent(pool);
  attributeDirectoryRefreshQueries();
  const nativeFuseki = new CountingFuseki(
    apps.FUSEKI_URL!,
    apps.FUSEKI_MAINTENANCE_TOKEN!,
    apps.FUSEKI_COMMAND_TOKEN!,
  );
  let loseCertificate = false;
  let mutate: ((envelope: CommandEnvelope) => CommandEnvelope) | undefined;
  let loseGraphResponse = false;
  let loseRetirementResponse = false;
  let loseFieldResponse = false;
  let loseFieldCertificate = false;
  let loseChildResponse = false;
  let loseChildCertificate = false;
  const creditCommands: Array<{ bytes: number; focuses: number }> = [];
  const fieldCommands: Array<{ bytes: number; focuses: number }> = [];
  const fuseki = new Proxy(nativeFuseki, {
    get(target, property) {
      if (property === 'commandWithReceipt')
        return async (envelope: CommandEnvelope) => {
          const credit = envelope.update.includes('AuthorCreditAdoptedEvent');
          const retirement = envelope.update.includes('AuthorCreditRetiredEvent');
          const field = envelope.update.includes('EditorialFieldControlEvent');
          const child = envelope.update.includes('NativeChildAdoptedEvent');
          const changed = credit && mutate ? mutate(envelope) : envelope;
          if (credit) mutate = undefined;
          if (credit)
            creditCommands.push({
              bytes: Buffer.byteLength(JSON.stringify(changed)),
              focuses: changed.validations.reduce((total, entry) => total + entry.focus.length, 0),
            });
          if (field)
            fieldCommands.push({
              bytes: Buffer.byteLength(JSON.stringify(changed)),
              focuses: changed.validations.reduce((total, entry) => total + entry.focus.length, 0),
            });
          const result = await target.commandWithReceipt(changed);
          if (credit && loseGraphResponse) {
            loseGraphResponse = false;
            throw new Error('lost graph acknowledgement');
          }
          if (retirement && loseRetirementResponse) {
            loseRetirementResponse = false;
            throw new Error('lost retirement acknowledgement');
          }
          if (field && loseFieldResponse) {
            loseFieldResponse = false;
            throw new Error('lost field acknowledgement');
          }
          if (child && loseChildResponse) {
            loseChildResponse = false;
            throw new Error('lost child acknowledgement');
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FusekiClient;
  const faultPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return async (query: string, params?: unknown[]) => {
          if (loseCertificate && query.startsWith('INSERT INTO source.author_credit_application')) {
            loseCertificate = false;
            throw new Error('interrupted before source certificate');
          }
          if (
            loseFieldCertificate &&
            query.startsWith('INSERT INTO source.field_support_outcome')
          ) {
            loseFieldCertificate = false;
            throw new Error('interrupted before field certificate');
          }
          if (
            loseChildCertificate &&
            query.startsWith('INSERT INTO source.native_child_application')
          ) {
            loseChildCertificate = false;
            throw new Error('interrupted before child certificate');
          }
          return target.query(query, params);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
  // A shard's graph retains earlier Context/Work heads. Their immutable bytes
  // must share its lifetime, including manifests read by rating/card hydration.
  const env = {
    fuseki,
    addresses: new AliasRegistry(accessPool),
    lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
    objectDirectory: apps.MAIN_OBJECT_DIRECTORY ?? objectDirectory,
  };
  const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
  // Production composes this too: without it public disclosure is empty, even for relation vocabulary.
  access.configureBaseline(fuseki);
  const intake = new SourceIntakeStore(pool),
    conversions = new OpenLibraryConversionStore(pool, intake);
  const graph = new OpenLibrarySourceGraph(fuseki, env.lineage, conversions);
  const proposals = new SourceNativeWorkProposalStore(pool, graph, conversions);
  const retainedAuthorNames = new Map<string, string>();
  const sourceAuthorNames = new SourceAuthorNameStore(pool, intake, (async (
    input: string | URL | Request,
  ) => {
    const authorKey = new URL(String(input)).pathname.replace(/\.json$/u, '');
    return Response.json({
      key: authorKey,
      type: { key: '/type/author' },
      revision: 1,
      name: retainedAuthorNames.get(authorKey),
    });
  }) as typeof fetch);
  const correspondences = new SourceChildCorrespondenceStore(pool, conversions);
  const adoptions = new SourceNativeWorkAdoptionStore(
    pool,
    proposals,
    env,
    account.verifier,
    access,
  );
  const credits = new SourceAuthorCreditStore(
    faultPool,
    proposals,
    conversions,
    correspondences,
    env,
    account.verifier,
    access,
  );
  const nativeChildren = new SourceNativeChildStore(
    faultPool,
    proposals,
    conversions,
    correspondences,
    env,
    account.verifier,
    access,
  );
  const principalId = randomUUID(),
    otherPrincipal = randomUUID(),
    actor = nativeId();
  await accessPool.query(
    `INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [principalId, account.issuer, account.a.id, otherPrincipal, account.b.id],
  );
  await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
    actor,
  ]);
  const grant = async (scope: string, action: string) => {
    await accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await accessPool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action],
    );
    const id = randomUUID();
    await accessPool.query(
      `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [id, actor, scope, action],
    );
    return id;
  };
  await grant('work:create:root', 'work.create');
  const fieldWithdrawals = new SourceFieldWithdrawalStore(pool, env);
  const rightsStore = new RightsStore(pool, accessPool);
  const ruleDigest = createHash('sha256').update('source-rights-rule-v1').digest('hex');
  const governance = new GovernanceStore(
    accessPool,
    ownerEvidenceCapture({
      source: async (principal, recordId, observationId) => {
        if (principal.subject !== account.a.id) return null;
        const value = await intake.read(principalId, observationId);
        return value && value.record.endsWith(recordId)
          ? {
              record: value.record,
              retention: value.retention,
              byteDigest: value.byteDigest,
              mediaType: value.mediaType,
            }
          : null;
      },
    }),
    { current: async () => null },
    {
      current: async (ref) =>
        ref === 'urn:rezics:rule:source-rights' ? { revision: 'v1', digest: ruleDigest } : null,
    },
  );
  let source: Record<string, unknown> = {};
  const catalogueIntake = new CatalogueIntakeStore(accessPool, env);
  const app = createMainApp(fuseki, {
    environment: env,
    account: account.verifier,
    access,
    ...(options.readingPositions ? { readingPositions: new ReadingPositionStore(pool) } : {}),
    catalogueIntake,
    actingContexts: new AccessActingContexts(accessPool),
    mediaAccess: new MediaAccessBatchReader(accessPool, fuseki),
    accessPolicy: new AccessPolicyOwner(accessPool),
    governance: { store: governance },
    rights: { store: rightsStore },
    protectionSigner: new ProtectionAdmissionSigner(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY),
    sourceIntake: intake,
    recipeSourceConversions: new RecipeSourceConversionStore(pool, intake),
    sourceConversions: conversions,
    sourceGraph: graph,
    sourceProposals: proposals,
    sourceCorrespondences: correspondences,
    sourceAdoptions: adoptions,
    sourceAuthorCredits: credits,
    sourceAuthorNames,
    sourceNativeChildren: nativeChildren,
    sourceProviderIdentity: new ProviderIdentityStore(pool),
    sourceFieldWithdrawals: fieldWithdrawals,
    sourceFieldApplications: new SourceFieldApplicationStore(
      faultPool,
      env,
      account.verifier,
      access,
      conversions,
      adoptions,
      fieldWithdrawals,
      rightsStore,
    ),
    sourceFieldAttachments: new SourceFieldAttachmentStore(pool, env, access),
    sourceAttachments: new SourceNativeWorkAttachmentStore(pool, proposals, adoptions, env, access),
    openLibraryFetch: (async (_input: string | URL | Request) =>
      new Response(JSON.stringify(source), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  const call = (
    method: string,
    path: string,
    body?: object,
    key = randomUUID(),
    token: string | null = account.tokenA,
  ) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const result = await response.json();
    if (response.status !== status)
      console.error('author credit fixture response', response.status, result);
    expect(response.status).toBe(status);
    return result as T;
  };
  let authorReady: Promise<void> | undefined;
  const authoredBody = async <T extends { actingSubject: string }>(body: T) => {
    if (body.actingSubject !== actor)
      throw new Error('Authored fixture body must use its represented Agent');
    authorReady ??= provisionFixtureAuthor(env, actor);
    await authorReady;
    return { ...body, authoring: 'own-work' as const };
  };
  const candidateReceipts = new Map<string, string>();
  const catalogueBody = async <T extends { title: string; language?: string }>(
    body: T,
    key?: string,
  ) => {
    const language = body.language ?? 'und';
    let candidateReceipt = key ? candidateReceipts.get(key) : undefined;
    if (!candidateReceipt)
      ({ candidateReceipt } = await json<{ candidateReceipt: string }>(
        await call('POST', '/v1/catalogue/candidates', {
          profile: 'catalogue-candidates-v1',
          originalTitle: { value: body.title, language },
          aliases: [],
          romanizations: [],
          creators: [],
          dates: [],
          identifiers: [],
        }),
        200,
      ));
    if (key) candidateReceipts.set(key, candidateReceipt);
    return { ...body, language, grain: 'new-creative-scope' as const, candidateReceipt };
  };
  const propose = async (
    workId: string,
    authors: unknown,
    title = 'Author credit Work',
    description?: string,
    subjects?: string[],
  ) => {
    source = {
      key: `/works/${workId}`,
      type: { key: '/type/work' },
      title,
      ...(authors === undefined ? {} : { authors }),
      ...(description === undefined ? {} : { description }),
      ...(subjects === undefined ? {} : { subjects }),
    };
    const capture = await json<{ observation: { observation: string } }>(
      await call('POST', '/v1/sources/acquisitions/open-library/works', {
        profile: 'open-library-work-acquisition-v1',
        workId,
      }),
      201,
    );
    const converted = await json<{ conversion: { conversion: string; observation: string } }>(
      await call(
        'POST',
        `/v1/sources/observations/${shortId(capture.observation.observation)}/conversions/open-library-work`,
        { profile: 'open-library-work-map-v1' },
      ),
      201,
    );
    const conversion = shortId(converted.conversion.conversion);
    await json(
      await call('POST', `/v1/sources/conversions/${conversion}/source-graph`, {
        profile: 'source-open-library-work-v1',
      }),
      200,
    );
    const result = await json<{ proposal: NativeWorkSourceProposal }>(
      await call('POST', `/v1/sources/conversions/${conversion}/proposals/native-work`, {
        profile: 'open-library-native-work-proposal-v1',
      }),
      201,
    );
    return result.proposal;
  };
  const adoptWork = async (proposal: NativeWorkSourceProposal) =>
    (
      await json<{ adoption: NativeWorkSourceAdoption }>(
        await call(
          'POST',
          `/v1/sources/proposals/${shortId(proposal.proposal)}/adoption/native-work`,
          {
            profile: 'source-native-work-adoption-v1',
            confirmedTitle: proposal.candidateTitle,
            actingSubject: actor,
            titleLanguage: 'en',
          },
        ),
        201,
      )
    ).adoption;
  const input = (
    proposal: NativeWorkSourceProposal,
    work: NativeWorkSourceAdoption,
    sourceOrdinal: number,
    key = '/authors/OL1A',
  ): AdoptSourceAuthorCreditInput & { profile: string } => ({
    profile: 'source-author-credit-adoption-v1',
    proposal: proposal.proposal,
    conversion: proposal.conversion,
    expectedHead: work.workRevision,
    actingSubject: actor,
    sourceOrdinal,
    nativeOrdinal: sourceOrdinal,
    occurrence: sourceChildOccurrence(proposal.observation, 'authors', sourceOrdinal),
    confirmedSourceKey: key,
    confirmedRoleKey: '/type/author_role',
    baseSupport: null,
    correspondence: null,
    confirmedUse: 'factual-reference-only',
  });
  return {
    account,
    pool,
    accessPool,
    env,
    access,
    intake,
    conversions,
    graph,
    proposals,
    adoptions,
    rightsStore,
    governance,
    ruleDigest,
    credits,
    nativeChildren,
    principalId,
    otherPrincipal,
    actor,
    sourceAuthorNames,
    setAuthorName: (key: string, name: string) => retainedAuthorNames.set(key, name),
    call,
    json,
    authoredBody,
    catalogueBody,
    catalogueIntake,
    grant,
    propose,
    adoptWork,
    input,
    nativeFuseki,
    creditCommands,
    fieldCommands,
    failCertificate: () => {
      loseCertificate = true;
    },
    loseGraph: () => {
      loseGraphResponse = true;
    },
    loseRetirementGraph: () => {
      loseRetirementResponse = true;
    },
    loseFieldGraph: () => {
      loseFieldResponse = true;
    },
    failFieldCertificate: () => {
      loseFieldCertificate = true;
    },
    loseChildGraph: () => {
      loseChildResponse = true;
    },
    failChildCertificate: () => {
      loseChildCertificate = true;
    },
    mutateCredit: (fn: (envelope: CommandEnvelope) => CommandEnvelope) => {
      mutate = fn;
    },
    close: async () => {
      await account.close();
      await Promise.all([pool.end(), accessPool.end()]);
    },
  };
}
