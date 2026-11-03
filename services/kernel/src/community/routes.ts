import { listRealmDiscovery } from './discovery.ts';
import { requestRealmClaim } from './realm-continuity.ts';
import { readOwnRealmClaimPage } from './realm-claim-status.ts';
import { listRealmClaimRequests } from './realm-claim-review.ts';
import { exactRealmPresentationImage } from '../content/realm-media.ts';
import { approveRealmClaim } from '../access/realm-claim.ts';
import { realmClaimApprovalResponseSchema } from './schemas.ts';
import {
  discoveryQuerySchema,
  discoveryResponseSchema,
  RealmClaimRequestInputSchema,
  RealmClaimRequestSchema,
} from './schemas.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { parseItem } from 'structured-headers';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { normalizeHandle } from '../access/lifecycle.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { customMethod } from '../http/custom-method.ts';
import { PROBLEMS, ProblemError, problemSchema, type ProblemCode } from '../http/problem.ts';
import { ResourceAccessWriteDeniedError } from '../access/resource-denials.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { accessCheck, AuthenticationError, type Access, type AccessClient } from '../request/access.ts';
import { REACTION_KINDS } from '../content/events.ts';
import { MediaUnavailableError } from '../content/media.ts';
import { SitemapQuerySchema } from '../content/schemas.ts';
import { SitemapRealmPageSchema, SitemapSpacePageSchema } from './schemas.ts';
import { InvalidCommunitySitemapCursorError, listSitemapRealms, listSitemapSpaces } from './sitemap.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  createSpace,
  readSpace,
  readSpaceForViewer,
  spaceReadEligibility,
  SpaceConflictError,
  SpaceInputError,
  updateSpace,
  type Space,
  type SpaceDependencies,
} from './space.ts';
import { claimSpaceAddress, readSpaceAddress, SpaceAddressConflictError } from './space-address.ts';
import {
  createRealm,
  readRealm,
  RealmConflictError,
  RealmInputError,
  updateRealm,
  type RealmDependencies,
  type RealmView,
} from './realm.ts';
import {
  ContainerLifecycleConflictError,
  readContainerLifecycle,
  removeContainer,
  restoreContainer,
} from './container-lifecycle.ts';
import { setBoardScheme } from './board-scheme.ts';
import { createRealmParticipationCheck } from './participation.ts';
import {
  enqueueRealmJoin,
  enqueueRealmLeave,
  readOwnRealmMembership,
  RealmMembershipConflictError,
  type MembershipDependencies,
} from './join.ts';
import { banAccount, unbanAccount, listBans, RealmBanInputError, RealmBanRoleError } from './ban.ts';
import { readRealmMembershipInterval } from './membership.ts';
import {
  assertRealmMemberPageBytes,
  confirmRealmMemberSelection,
  MemberPageUnavailableError,
  publicMemberIdentity,
  readRealmMemberActions,
  readRealmMemberIdentities,
  selectRealmMembers,
} from './member-page.ts';
import { listOwnRealms } from './own-realms.ts';
import { RealmPresentationSchema } from './presentation.ts';
import { CommunityPresentationSchema, communityPresentationResponse } from '../content/community-presentation-model.ts';
import { readCommunityPresentations } from '../content/community-presentation.ts';
import { readRealmHomePresentation } from './realm-home-presentation.ts';
import { readRealmSettingsPage, RealmSettingsPageSchema } from './settings-page.ts';
import {
  createRealmHomePublicationReader,
  RealmHomePublicationPageSchema,
  RealmHomePublicationQuerySchema,
  realmHomePublicationResponse,
} from './realm-home-publications.ts';
import { ownRealmsQuerySchema, ownRealmsResponseSchema } from './schemas.ts';
import { PublicationPreparationResponseSchema, readPublicationPreparation } from './publication-preparation.ts';
import {
  listPublications,
  publish,
  PublicationConflictError,
  PublicationOccupiedSlotError,
  PublicationCursorError,
  PublicationInputError,
  readPublication,
  reject,
  withdraw,
  type PublicationHead,
  type PublicationResult,
} from './publication.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const instant = t.String({ format: 'date-time' });
const title = t.String({ minLength: 1, maxLength: 1024 });
const summary = t.String({ maxLength: 4096 });
const space = t.Object(
  {
    spaceId: id,
    realmId: t.Union([id, t.Null()], {
      readOnly: true,
      description:
        'The active Realm carried by this Space, if the viewer passes its ordinary realm:read check; otherwise null. Derived per viewer and outside the Space revision chain. The Space ETag remains its head revision id, the If-Match token for Space writes.',
    }),
    state: t.Literal('active'),
    headRevisionId: id,
    createdAt: instant,
    creator: id,
    predecessor: t.Union([id, t.Null()]),
    address: t.Union([t.String(), t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
  },
  closed,
);
const claimReviewResponse = t.Object(
  {
    claimRequests: t.Array(
      t.Object(
        {
          realmId: id,
          requestId: id,
          claimantAccountId: id,
          state: t.Literal('pending'),
          orphanedAt: instant,
          claimEligibleAt: instant,
          requestedAt: instant,
          claimant: t.Object(
            { label: t.String({ maxLength: 4096 }), href: t.Union([t.String({ maxLength: 4096 }), t.Null()]) },
            closed,
          ),
          approvalAdvice: t.Object(
            {
              method: t.Literal('POST'),
              destination: t.String({ maxLength: 4096 }),
              requiredAction: t.Literal('realm:approve_claim'),
              requiredHeader: t.Literal('Idempotency-Key'),
            },
            closed,
          ),
        },
        closed,
      ),
      { maxItems: 20 },
    ),
    next: t.Union([t.String(), t.Null()]),
    selectedRequest: t.Union([
      t.Object(
        {
          requestId: id,
          claimantAccountId: id,
          state: t.Literal('pending'),
          orphanedAt: instant,
          claimEligibleAt: instant,
          requestedAt: instant,
          currentEpisode: t.Literal(true),
          claimant: t.Object(
            { label: t.String({ maxLength: 4096 }), href: t.Union([t.String({ maxLength: 4096 }), t.Null()]) },
            closed,
          ),
          approvalAdvice: t.Object(
            {
              method: t.Literal('POST'),
              destination: t.String({ maxLength: 4096 }),
              requiredAction: t.Literal('realm:approve_claim'),
              requiredHeader: t.Literal('Idempotency-Key'),
            },
            closed,
          ),
        },
        closed,
      ),
      t.Object(
        {
          requestId: id,
          state: t.Literal('approved'),
          orphanedAt: instant,
          requestedAt: instant,
          approvedAt: instant,
          currentEpisode: t.Literal(false),
        },
        closed,
      ),
      t.Null(),
    ]),
    realmPresentation: t.Union([
      t.Object(
        {
          state: t.Literal('available'),
          name: t.String({ maxLength: 1024 }),
          description: t.String({ maxLength: 4096 }),
        },
        closed,
      ),
      t.Object({ state: t.Literal('unavailable') }, closed),
    ]),
  },
  closed,
);
const claimReviewQuery = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
    cursor: t.Optional(t.String({ maxLength: 4096 })),
    inspectRequestId: t.Optional(id),
  },
  closed,
);

const spaceResponse = t.Object({ space }, closed);
const spaceHomeResponse = t.Object({ space, community: t.Union([CommunityPresentationSchema, t.Null()]) }, closed);
const voteWeight = t.Unsafe<1 | -1>(t.Integer({ enum: [1, -1] }));
const votes = t.Object(
  {
    upvote: t.Optional(voteWeight),
    downvote: t.Optional(voteWeight),
    like: t.Optional(voteWeight),
    love: t.Optional(voteWeight),
    laugh: t.Optional(voteWeight),
    insightful: t.Optional(voteWeight),
    sad: t.Optional(voteWeight),
  } satisfies Record<(typeof REACTION_KINDS)[number], unknown>,
  closed,
);
const realm = t.Object(
  {
    realmId: id,
    spaceId: id,
    state: t.Literal('active'),
    visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
    contextId: id,
    boardSchemeId: t.Union([id, t.Null()]),
    ownershipState: t.Union([t.Literal('owned'), t.Literal('orphaned')]),
    orphanedAt: t.Union([instant, t.Null()]),
    claimEligibleAt: t.Union([instant, t.Null()]),
    governanceReadOnly: t.Boolean(),
    headRevisionId: id,
    createdAt: instant,
    creator: id,
    predecessor: t.Union([id, t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
    votes,
    presentation: RealmPresentationSchema,
  },
  closed,
);
const realmResponse = t.Object({ realm }, closed);
const realmClaimStatus = t.Object(
  {
    realmId: id,
    requestId: id,
    state: t.Union([t.Literal('pending'), t.Literal('approved')]),
    orphanedAt: instant,
    requestedAt: instant,
    approvedAt: t.Union([instant, t.Null()]),
    currentEpisode: t.Boolean(),
  },
  closed,
);
const realmClaimCurrentContext = t.Object(
  {
    ownershipState: t.Union([t.Literal('owned'), t.Literal('orphaned')]),
    orphanedAt: t.Union([instant, t.Null()]),
    claimEligibleAt: t.Union([instant, t.Null()]),
  },
  closed,
);
const realmClaimRequestAdvice = t.Object(
  {
    available: t.Boolean(),
    method: t.Literal('POST'),
    destination: t.String({ maxLength: 4096 }),
    requiredAction: t.Literal('realm:participate'),
    requiredHeader: t.Literal('Idempotency-Key'),
    body: t.Object({}, closed),
  },
  closed,
);
const realmClaimOwnPageResponse = t.Object(
  {
    claimRequest: t.Union([realmClaimStatus, t.Null()]),
    currentRealm: realmClaimCurrentContext,
    requestAdvice: realmClaimRequestAdvice,
  },
  closed,
);
const realmClaimExactResponse = t.Object(
  {
    claimRequest: realmClaimStatus,
    currentRealm: realmClaimCurrentContext,
    requestAdvice: realmClaimRequestAdvice,
  },
  closed,
);
const publicationFields = {
  realmId: id,
  subjectId: id,
  publicationId: id,
  subjectRevisionId: t.Null(),
  publishedAt: instant,
};
const publication = t.Object({ ...publicationFields, verdict: t.Literal('adopt') }, closed);
const publicationResponse = t.Object({ publication }, closed);
const decisionResponse = t.Object(
  {
    publication: t.Object(
      {
        ...publicationFields,
        verdict: t.Union([t.Literal('withdraw'), t.Literal('reject')]),
        predecessor: t.Union([id, t.Null()]),
      },
      closed,
    ),
  },
  closed,
);
const publicationPage = t.Object({ items: t.Array(publication), next: t.Union([t.String(), t.Null()]) }, closed);
const accepted = t.Object({ workflowId: t.String({ minLength: 1, maxLength: 200 }) }, closed);
const membershipState = t.Object(
  {
    state: t.Union([t.Literal('none'), t.Literal('pending'), t.Literal('member')]),
    since: t.Union([instant, t.Null()]),
  },
  closed,
);
const addMemberInput = t.Object({ accountId: id }, closed);
const publicationParams = t.Object({ realmId: t.String(), subjectId: t.String() }, closed);

const lifecycleVersion = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const containerKind = t.Union([t.Literal('space'), t.Literal('realm')]);
const lifecycleState = t.Union([t.Literal('active'), t.Literal('removed')]);
const lifecycleResult = t.Object(
  {
    container: t.Object(
      {
        kind: containerKind,
        id,
        state: lifecycleState,
        headRevisionId: id,
        version: lifecycleVersion,
      },
      closed,
    ),
  },
  closed,
);
const lifecycleResponse = t.Object(
  {
    container: t.Object(
      {
        ...lifecycleResult.properties.container.properties,
        removedAt: t.Union([instant, t.Null()]),
        reason: t.Union([t.String(), t.Null()]),
        removerRole: t.Union([t.Literal('owner'), t.Literal('moderator'), t.Null()]),
        mayRemove: t.Boolean(),
        mayRestore: t.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
const removeContainerInput = t.Object(
  { expectedVersion: lifecycleVersion, reason: t.String({ minLength: 1, maxLength: 1024 }) },
  closed,
);
const restoreContainerInput = t.Object({ expectedVersion: lifecycleVersion }, closed);

const createInput = t.Object({ title, summary: t.Optional(summary) }, closed);
const updateInput = t.Object({ title: t.Optional(title), summary: t.Optional(summary) }, closed);
const addressInput = t.Object({ address: t.String({ minLength: 1, maxLength: 64 }) }, closed);
const createRealmInput = t.Object(
  {
    spaceId: id,
    title,
    summary: t.Optional(summary),
    visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
    contextId: id,
    votes: t.Optional(votes),
  },
  closed,
);
const updateRealmInput = t.Object(
  {
    presentation: t.Optional(RealmPresentationSchema),
    title: t.Optional(title),
    summary: t.Optional(summary),
    visibility: t.Optional(t.Union([t.Literal('public'), t.Literal('protected')])),
    contextId: t.Optional(id),
    votes: t.Optional(votes),
  },
  closed,
);

/** Standard-schema validation keeps unknown fields instead of removing them. */
function strict<S extends TSchema>(schema: S) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return validator.Check(value)
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the community request schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

const banParams = t.Object({ realmId: t.String(), accountId: id }, closed);
const banRecord = t.Object(
  { accountId: id, reason: t.String({ maxLength: 1024 }), actor: t.Union([id, t.Null()]), at: t.String() },
  closed,
);
const banResponse = t.Object(
  { ban: t.Object({ ...banRecord.properties, realmId: id, workflowId: t.Union([t.String(), t.Null()]) }, closed) },
  closed,
);
const banPage = t.Object({ items: t.Array(banRecord), next: t.Union([t.String(), t.Null()]) }, closed);
const memberIdentity = t.Union([
  t.Object(
    {
      id,
      kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
      state: t.Literal('active'),
      handle: t.Union([t.String({ maxLength: 64 }), t.Null()]),
      displayName: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
    },
    closed,
  ),
  t.Object(
    {
      id,
      kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
      state: t.Literal('deleted'),
    },
    closed,
  ),
]);
const memberAction = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      method: t.Union([t.Literal('POST'), t.Literal('PUT'), t.Literal('DELETE')]),
      path: t.String({ maxLength: 1024 }),
      body: t.Union([
        t.Object({ accountId: id }, closed),
        t.Object({ reason: t.String({ maxLength: 1024 }) }, closed),
        t.Null(),
      ]),
      expectedStatus: t.Union([t.Literal(202), t.Literal(200), t.Literal(204)]),
      outcome: t.String({ maxLength: 160 }),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('prohibited'),
      reason: t.Union([
        t.Literal('already_member'),
        t.Literal('already_banned'),
        t.Literal('not_banned'),
        t.Literal('not_authorized'),
        t.Literal('protected_owner_or_moderator'),
        t.Literal('deleted_account'),
        t.Literal('identity_unavailable'),
      ]),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('uncertain'),
      reason: t.Union([t.Literal('authority_unavailable'), t.Literal('identity_unavailable')]),
    },
    closed,
  ),
  t.Object({ state: t.Literal('unavailable'), reason: t.Literal('no_mounted_method') }, closed),
]);
const memberActions = t.Object(
  {
    addMember: memberAction,
    ban: memberAction,
    unban: memberAction,
    removeMember: memberAction,
    reviseRole: memberAction,
  },
  closed,
);
const memberRow = t.Object(
  {
    accountId: id,
    membership: t.Literal('member'),
    identity: t.Union([memberIdentity, t.Null()]),
    displayName: t.String({ maxLength: 4096 }),
    banState: t.Union([t.Literal('banned'), t.Literal('clear'), t.Literal('unknown')]),
    actions: memberActions,
  },
  closed,
);
const selectedMember = t.Object(
  {
    accountId: id,
    membership: t.Union([t.Literal('member'), t.Literal('none')]),
    identity: t.Union([memberIdentity, t.Null()]),
    displayName: t.String({ maxLength: 4096 }),
    banState: t.Union([t.Literal('banned'), t.Literal('clear'), t.Literal('unknown')]),
    actions: memberActions,
  },
  closed,
);
const memberPageQuery = t.Object(
  { cursor: t.Optional(t.String({ maxLength: 4096 })), accountId: t.Optional(id) },
  closed,
);
const memberPageResponse = t.Object(
  {
    realmId: id,
    state: t.Union([t.Literal('ready'), t.Literal('preparing')]),
    items: t.Array(memberRow, { maxItems: 20 }),
    next: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
    selected: t.Union([selectedMember, t.Null()]),
  },
  {
    ...closed,
    examples: [
      {
        realmId: '00000000-0000-0000-0000-000000000010',
        state: 'ready',
        items: [
          {
            accountId: '00000000-0000-0000-0000-000000000020',
            membership: 'member',
            identity: {
              id: '00000000-0000-0000-0000-000000000020',
              kind: 'actor',
              state: 'active',
              handle: 'member',
              displayName: null,
            },
            displayName: 'Member',
            banState: 'clear',
            actions: {
              addMember: { state: 'prohibited', reason: 'already_member' },
              ban: {
                state: 'available',
                method: 'PUT',
                path: '/v1/realms/00000000-0000-0000-0000-000000000010/bans/00000000-0000-0000-0000-000000000020',
                body: { reason: '' },
                expectedStatus: 200,
                outcome: 'Ban commits; membership removal may still be pending.',
              },
              unban: { state: 'prohibited', reason: 'not_banned' },
              removeMember: { state: 'unavailable', reason: 'no_mounted_method' },
              reviseRole: { state: 'unavailable', reason: 'no_mounted_method' },
            },
          },
        ],
        next: null,
        selected: null,
      },
      {
        realmId: '00000000-0000-0000-0000-000000000010',
        state: 'preparing',
        items: [],
        next: null,
        selected: null,
      },
    ],
  },
);
const memberPageNotFound = t.Object(
  { ...problemSchema('not_found').properties },
  {
    additionalProperties: false,
    examples: [
      {
        type: 'https://rezics.com/problems/not_found',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
        retryable: false,
        effect_status: 'not_applicable',
        request_id: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'https://rezics.com/problems/not_found',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
        retryable: false,
        effect_status: 'not_applicable',
        request_id: '00000000-0000-0000-0000-000000000002',
      },
    ],
  },
);
const memberPageForbidden = t.Object(
  { ...problemSchema('forbidden').properties },
  {
    additionalProperties: false,
    examples: [
      {
        type: 'https://rezics.com/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        code: 'forbidden',
        retryable: false,
        effect_status: 'not_applicable',
        request_id: '00000000-0000-0000-0000-000000000003',
      },
    ],
  },
);
const memberPageUnavailable = t.Object(
  {
    ...problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
    ).properties,
  },
  {
    additionalProperties: false,
    examples: [
      {
        type: 'https://rezics.com/problems/dependency_unavailable',
        title: 'Dependency Unavailable',
        status: 503,
        code: 'dependency_unavailable',
        retryable: true,
        effect_status: 'not_applicable',
        request_id: '00000000-0000-0000-0000-000000000004',
      },
    ],
  },
);
const sitemapQuery = strict(SitemapQuerySchema);
const sitemapRealmPage = strict(SitemapRealmPageSchema);
const sitemapSpacePage = strict(SitemapSpacePageSchema);
const banQuery = t.Object(
  { limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })), cursor: t.Optional(t.String()) },
  closed,
);

const readFailures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
  ),
};
const writeFailures = {
  ...readFailures,
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
  429: problemSchema('rate_limited'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
    'rate_limit_unavailable',
  ),
};
// Bind only the original problem catalogue. Until Access delivers its discriminator,
// its native refusal stays generic; Community never manufactures the specific error.
const realmLeaveConflict = problemSchema(
  'conflict',
  ...Object.keys(PROBLEMS).filter((code): code is ProblemCode => code === 'realm_last_owner'),
);
const sessionHeader = { [SESSION_HEADER]: t.String() };
const commandHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const publicationHeaders = t.Object(
  { [IDEMPOTENCY_HEADER]: t.String(), 'if-match': t.Optional(t.String()) },
  { additionalProperties: true },
);
const updateHeaders = t.Object(
  { [IDEMPOTENCY_HEADER]: t.String(), 'if-match': t.String() },
  { additionalProperties: true },
);
const readSecurity = [{ bearerAuth: [] }, {}];
const writeSecurity = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const params = t.Object({ spaceId: t.String() }, closed);
const addressParams = t.Object({ address: t.String() }, closed);
const realmParams = t.Object({ realmId: t.String() }, closed);
const sitemapFailures = { ...readFailures, 400: problemSchema('invalid_request', 'invalid_cursor') };
const SITEMAP_DESCRIPTION = (kind: 'Realms' | 'Spaces') =>
  `Keyset feed of the public ${kind} for server-to-server sitemaps, evaluated as an anonymous reader. Each page ` +
  `examines at most 4 × limit candidates and may return fewer than limit items. Follow next until it is null.`;

export type CommunityRouteDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  clock?: () => Date;
  access: () => Access;
  tokens: KeyRing;
  workClient: () => Promise<WorkClient>;
};

function communityProblem(error: unknown): never {
  // Preserve the native ownership subclass for the central problem mapper.
  if (error instanceof ResourceAccessWriteDeniedError) throw error;
  if (error instanceof MemberPageUnavailableError) throw new ProblemError('dependency_unavailable');
  if (error instanceof RealmBanRoleError) throw new ProblemError('conflict', { detail: error.message });
  if (error instanceof RealmBanInputError) throw new ProblemError('invalid_request');
  if (error instanceof SpaceInputError) throw new ProblemError('invalid_request');
  if (error instanceof SpaceAddressConflictError) throw new ProblemError('conflict');
  if (error instanceof RealmInputError || error instanceof PublicationInputError)
    throw new ProblemError('invalid_request');
  if (error instanceof MediaUnavailableError) throw new ProblemError('media_unavailable');
  if (error instanceof PublicationCursorError)
    throw new ProblemError(error.reason === 'stale' ? 'stale_cursor' : 'invalid_cursor');
  if (error instanceof PublicationOccupiedSlotError) throw new ProblemError('conflict');
  if (error instanceof PublicationConflictError) throw new ProblemError('not_found');
  if (error instanceof ContainerLifecycleConflictError) throw new ProblemError('precondition_failed');
  if (error instanceof SpaceConflictError || error instanceof RealmConflictError)
    throw new ProblemError('precondition_failed');
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  if (error instanceof RealmMembershipConflictError) throw new ProblemError('idempotency_conflict');
  throw error;
}

function communitySitemapProblem(error: unknown): never {
  if (error instanceof InvalidCommunitySitemapCursorError) throw new ProblemError('invalid_cursor');
  if (error instanceof RangeError) throw new ProblemError('invalid_request');
  throw error;
}

function matchHead(header: string): string {
  let value: unknown;
  try {
    [value] = parseItem(header);
  } catch {
    throw new ProblemError('invalid_request');
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) throw new ProblemError('invalid_request');
  return value;
}

function published(space: Space, realmId: string | null = null) {
  if (space.state !== 'active') throw new ProblemError('not_found');
  return {
    spaceId: space.spaceId,
    realmId,
    state: 'active' as const,
    headRevisionId: space.headRevisionId,
    createdAt: space.createdAt,
    creator: space.creator,
    predecessor: space.predecessor,
    address: space.address,
    title: space.title,
    summary: space.summary,
    revisionCreatedAt: space.revisionCreatedAt,
    author: space.author,
  };
}

function publishedRealm(value: RealmView) {
  if (value.state !== 'active') throw new ProblemError('not_found');
  return {
    realmId: value.realmId,
    spaceId: value.spaceId,
    state: 'active' as const,
    visibility: value.visibility as 'public' | 'protected',
    contextId: value.contextId,
    boardSchemeId: value.boardSchemeId,
    ownershipState: value.ownershipState,
    orphanedAt: value.orphanedAt,
    claimEligibleAt: value.claimEligibleAt,
    governanceReadOnly: value.governanceReadOnly,
    headRevisionId: value.headRevisionId,
    createdAt: value.createdAt,
    creator: value.creator,
    predecessor: value.predecessor,
    title: value.title,
    summary: value.summary,
    revisionCreatedAt: value.revisionCreatedAt,
    author: value.author,
    votes: value.votes,
    presentation: value.presentation,
  };
}

function publishedPublication(value: PublicationHead | PublicationResult) {
  return {
    realmId: value.realmId,
    subjectId: value.subjectId,
    publicationId: value.publicationId,
    verdict: 'adopt' as const,
    subjectRevisionId: null,
    publishedAt: new Date(value.publishedAt).toISOString(),
  };
}

type MemberBanPermission = boolean | null;

function prohibitedMemberAction(
  reason:
    | 'already_member'
    | 'already_banned'
    | 'not_banned'
    | 'not_authorized'
    | 'protected_owner_or_moderator'
    | 'deleted_account'
    | 'identity_unavailable',
) {
  return { state: 'prohibited' as const, reason };
}

function uncertainMemberAction(reason: 'authority_unavailable' | 'identity_unavailable' = 'authority_unavailable') {
  return { state: 'uncertain' as const, reason };
}

function unavailableMemberAction() {
  return { state: 'unavailable' as const, reason: 'no_mounted_method' as const };
}

function availableMemberAction(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: { accountId: string } | { reason: string } | null,
  expectedStatus: 202 | 200 | 204,
  outcome: string,
) {
  return { state: 'available' as const, method, path, body, expectedStatus, outcome };
}

function sameIdentityAnchor(
  before: import('../access/account-data.ts').PublicIdentity | undefined,
  after: import('../access/account-data.ts').PublicIdentity | undefined,
) {
  if (!before || !after) return before === after;
  return before.id === after.id && before.kind === after.kind && before.state === after.state;
}

function memberActionAdvice(input: {
  realmId: string;
  accountId: string;
  membership: 'member' | 'none';
  identity: ReturnType<typeof publicMemberIdentity>['identity'];
  banPermission: MemberBanPermission;
  ban: { banned: boolean; protectedRole: boolean | null } | undefined;
}) {
  const activeIdentity = input.identity !== null && input.identity.state === 'active';
  const missingIdentity = input.identity === null;
  const addMember =
    input.membership === 'member'
      ? prohibitedMemberAction('already_member')
      : missingIdentity
        ? uncertainMemberAction('identity_unavailable')
        : input.identity?.state === 'deleted'
          ? prohibitedMemberAction('deleted_account')
          : input.banPermission === null
            ? uncertainMemberAction()
            : input.banPermission && input.ban?.banned
              ? prohibitedMemberAction('already_banned')
              : input.banPermission && !input.ban
                ? uncertainMemberAction()
                : !input.banPermission
                  ? uncertainMemberAction()
                  : availableMemberAction(
                      'POST',
                      `/v1/realms/${input.realmId}/members`,
                      { accountId: input.accountId },
                      202,
                      'Accepted; a membership workflow may still be pending.',
                    );
  const authorityAction = (allowMissingIdentity = false) => {
    if (input.banPermission === null) return uncertainMemberAction();
    if (!input.banPermission) return prohibitedMemberAction('not_authorized');
    if (!input.ban) return uncertainMemberAction();
    if (missingIdentity && !allowMissingIdentity) return uncertainMemberAction('identity_unavailable');
    return null;
  };
  const banAuthority = authorityAction();
  const ban =
    banAuthority ??
    (!activeIdentity
      ? prohibitedMemberAction('deleted_account')
      : input.ban!.banned
        ? prohibitedMemberAction('already_banned')
        : input.ban!.protectedRole === null
          ? uncertainMemberAction()
          : input.ban!.protectedRole
            ? prohibitedMemberAction('protected_owner_or_moderator')
            : availableMemberAction(
                'PUT',
                `/v1/realms/${input.realmId}/bans/${input.accountId}`,
                { reason: '' },
                200,
                'Ban commits; membership removal may still be pending.',
              ));
  const unbanAuthority = authorityAction(true);
  const unban =
    unbanAuthority ??
    (input.ban!.banned
      ? availableMemberAction(
          'DELETE',
          `/v1/realms/${input.realmId}/bans/${input.accountId}`,
          null,
          204,
          'The ban ends; membership is not restored.',
        )
      : prohibitedMemberAction('not_banned'));
  return {
    addMember,
    ban,
    unban,
    removeMember: unavailableMemberAction(),
    reviseRole: unavailableMemberAction(),
  };
}

export function communityRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: CommunityRouteDependencies) {
  const spaceDependencies = (): SpaceDependencies => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    access: dependencies.access(),
  });
  const realmDependencies = (): RealmDependencies => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    access: dependencies.access(),
  });
  const banDependencies = () => ({
    ...realmDependencies(),
    tokens: dependencies.tokens,
    workClient: dependencies.workClient,
  });
  const membershipDependencies = async (): Promise<MembershipDependencies> => ({
    pool: dependencies.pool,
    access: dependencies.access(),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    tokens: dependencies.tokens,
    client: await dependencies.workClient(),
  });
  const observedAt = () => (dependencies.clock ?? (() => new Date()))().toISOString();
  const sitemapDependencies = () => ({
    pool: dependencies.pool,
    access: dependencies.access(),
    tokens: dependencies.tokens,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });

  return app

    .get(
      '/v1/spaces/:spaceId/lifecycle',
      {
        params: t.Object({ spaceId: id }, closed),
        response: { 200: strict(lifecycleResponse), ...readFailures, 403: problemSchema('forbidden') },
        detail: {
          operationId: 'space.lifecycle',
          'x-exposure': 'public',
          'x-action': 'space:manage',
          'x-resource-types': ['community.space'],
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, actor, admission, job }) => {
        try {
          const container = await admission.run('normal', job, () =>
            readContainerLifecycle(spaceDependencies(), actor, 'space', spaceId, { deadline: job.deadline }),
          );
          if (!container) throw new ProblemError('not_found');
          return { container };
        } catch (error) {
          communityProblem(error);
        }
      },
    )

    .post(
      '/v1/spaces/:spaceId/removal',
      {
        params: t.Object({ spaceId: id }, closed),
        headers: updateHeaders,
        body: strict(removeContainerInput),
        response: {
          200: withHeaders(strict(lifecycleResult), sessionHeader),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'space.remove',
          'x-exposure': 'public',
          'x-action': 'space:manage',
          'x-resource-types': ['community.space'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await removeContainer(
              spaceDependencies(),
              actor,
              {
                kind: 'space',
                id: spaceId,
                expectedHead,
                expectedVersion: body.expectedVersion,
                reason: body.reason,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { container: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )

    .post(
      '/v1/spaces/:spaceId/restoration',
      {
        params: t.Object({ spaceId: id }, closed),
        headers: updateHeaders,
        body: strict(restoreContainerInput),
        response: {
          200: withHeaders(strict(lifecycleResult), sessionHeader),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'space.restore',
          'x-exposure': 'public',
          'x-action': 'space:restore',
          'x-resource-types': ['community.space'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await restoreContainer(
              spaceDependencies(),
              actor,
              {
                kind: 'space',
                id: spaceId,
                expectedHead,
                expectedVersion: body.expectedVersion,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { container: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )

    .get(
      '/v1/realms/:realmId/lifecycle',
      {
        params: t.Object({ realmId: id }, closed),
        response: { 200: strict(lifecycleResponse), ...readFailures, 403: problemSchema('forbidden') },
        detail: {
          operationId: 'realm.lifecycle',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-resource-types': ['community.realm'],
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job }) => {
        try {
          const container = await admission.run('normal', job, () =>
            readContainerLifecycle(spaceDependencies(), actor, 'realm', realmId, { deadline: job.deadline }),
          );
          if (!container) throw new ProblemError('not_found');
          return { container };
        } catch (error) {
          communityProblem(error);
        }
      },
    )

    .post(
      '/v1/realms/:realmId/removal',
      {
        params: t.Object({ realmId: id }, closed),
        headers: updateHeaders,
        body: strict(removeContainerInput),
        response: {
          200: withHeaders(strict(lifecycleResult), sessionHeader),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'realm.remove',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await removeContainer(
              spaceDependencies(),
              actor,
              {
                kind: 'realm',
                id: realmId,
                expectedHead,
                expectedVersion: body.expectedVersion,
                reason: body.reason,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { container: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )

    .post(
      '/v1/realms/:realmId/restoration',
      {
        params: t.Object({ realmId: id }, closed),
        headers: updateHeaders,
        body: strict(restoreContainerInput),
        response: {
          200: withHeaders(strict(lifecycleResult), sessionHeader),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'realm.restore',
          'x-exposure': 'public',
          'x-action': 'realm:restore',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await restoreContainer(
              spaceDependencies(),
              actor,
              {
                kind: 'realm',
                id: realmId,
                expectedHead,
                expectedVersion: body.expectedVersion,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { container: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/discovery',
      {
        query: discoveryQuerySchema,
        response: {
          200: discoveryResponseSchema,
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'realms.discovery',
          description:
            'Public discussion volume in the previous 30 complete UTC days (popular) or previous complete UTC day (trending). Examines at most min(limit,20) candidates; sparse and empty pages can have next. Deduplicate Realm IDs across pages.',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ query, admission, job }) =>
        admission.run('normal', job, async () => {
          const page = await listRealmDiscovery(
            {
              pool: dependencies.pool,
              access: dependencies.access(),
              tokens: dependencies.tokens,
              clock: dependencies.clock,
            },
            job.deadline,
            query,
          );
          return {
            ...page,
            realms: page.realms.map((realm) => ({
              ...realm,
              avatar: realm.avatar === null ? null : exactRealmPresentationImage(realm.avatar),
            })),
          };
        }),
    )
    .get(
      '/v1/sitemap/realms',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: sitemapRealmPage, ...sitemapFailures },
        detail: {
          operationId: 'sitemap_realms.list',
          description: SITEMAP_DESCRIPTION('Realms'),
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ query, admission, job }) => {
        try {
          return await admission.run('normal', job, () =>
            listSitemapRealms(sitemapDependencies(), job.deadline, query),
          );
        } catch (error) {
          communitySitemapProblem(error);
        }
      },
    )
    .get(
      '/v1/sitemap/spaces',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: sitemapSpacePage, ...sitemapFailures },
        detail: {
          operationId: 'sitemap_spaces.list',
          description: SITEMAP_DESCRIPTION('Spaces'),
          'x-exposure': 'public',
          'x-action': 'space:read',
          'x-resource-types': ['community.space'],
          security: readSecurity,
        },
      },
      async ({ query, admission, job }) => {
        try {
          return await admission.run('normal', job, () =>
            listSitemapSpaces(sitemapDependencies(), job.deadline, query),
          );
        } catch (error) {
          communitySitemapProblem(error);
        }
      },
    )
    .get(
      '/v1/me/realms',
      {
        query: strict(ownRealmsQuerySchema),
        response: {
          200: strict(ownRealmsResponseSchema),
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
          401: problemSchema('authentication_required', 'invalid_credentials'),
          500: problemSchema('internal_error'),
          503: problemSchema(
            'overloaded',
            'deadline_exceeded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'dependency_unavailable',
          ),
        },
        detail: {
          operationId: 'account.realms',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ query, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return admission.run('normal', job, () =>
          listOwnRealms(
            { ...realmDependencies(), tokens: dependencies.tokens },
            actor,
            { deadline: job.deadline, at: observedAt() },
            query,
          ),
        );
      },
    )
    .post(
      '/v1/spaces',
      {
        headers: commandHeaders,
        body: strict(createInput),
        response: {
          201: withHeaders(strict(spaceResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'space.create',
          'x-exposure': 'public',
          'x-action': 'space:create',
          'x-resource-types': ['community.space'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await createSpace(
              spaceDependencies(),
              actor,
              { title: body.title, ...(body.summary === undefined ? {} : { summary: body.summary }) },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = result.replayed
              ? await readSpaceForViewer(spaceDependencies(), actor, result.value.spaceId, observedAt(), {
                  deadline: job.deadline,
                })
              : await readSpace(dependencies.pool, result.value.spaceId, observedAt()).then(
                  (space) => space && { ...space, realmId: null },
                );
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = published(current, current.realmId);
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/spaces/${representation.spaceId}`;
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { space: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/spaces/:spaceId',
      {
        params,
        response: {
          200: withHeaders(strict(spaceHomeResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'space.get',
          'x-exposure': 'public',
          'x-action': 'space:read',
          'x-resource-types': ['community.space'],
          security: readSecurity,
        },
      },
      async ({ params: { spaceId }, actor, authorize, admission, job, set }) => {
        const route = routeOf(spaceId);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: spaceId };
        const check = await authorize({ ...resource, eligibility: spaceReadEligibility(resource) });
        const current = await admission.run('normal', job, () =>
          readSpaceForViewer(spaceDependencies(), actor, spaceId, observedAt(), { deadline: job.deadline }, check),
        );
        if (!current) throw new ProblemError('not_found');
        const community = current.realmId
          ? (
              await readCommunityPresentations(
                {
                  pool: dependencies.pool,
                  access: dependencies.access(),
                  ...(dependencies.clock ? { clock: dependencies.clock } : {}),
                },
                [current.realmId],
                { actor, deadline: job.deadline },
              )
            ).get(current.realmId)
          : null;
        if (current.realmId && !community) throw new ProblemError('not_found');
        // Re-read the Space after optional enrichment with the original admission.
        const final = await readSpaceForViewer(
          spaceDependencies(),
          actor,
          spaceId,
          observedAt(),
          { deadline: job.deadline },
          check,
        );
        if (!final || final.headRevisionId !== current.headRevisionId || final.realmId !== current.realmId)
          throw new ProblemError('not_found');
        const representation = published(final, final.realmId);
        set.headers.etag = JSON.stringify(representation.headRevisionId);
        return { space: representation, community: community ? communityPresentationResponse(community) : null };
      },
    )
    .put(
      '/v1/spaces/:spaceId/address',
      {
        params,
        headers: updateHeaders,
        body: strict(addressInput),
        response: {
          200: withHeaders(strict(spaceResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'space_address.change',
          'x-exposure': 'public',
          'x-action': 'space:manage',
          'x-resource-types': ['community.space'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await claimSpaceAddress(
              spaceDependencies(),
              actor,
              { spaceId, expectedHead, address: body.address },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readSpaceForViewer(spaceDependencies(), actor, result.value.spaceId, observedAt(), {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = published(current, current.realmId);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { space: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/spaceAddresses/:address',
      {
        params: addressParams,
        response: {
          200: strict(t.Object({ spaceId: id }, closed)),
          ...readFailures,
        },
        detail: {
          operationId: 'space_address.resolve',
          'x-exposure': 'public',
          'x-action': 'space:read',
          'x-resource-types': ['community.space'],
          security: readSecurity,
        },
      },
      async ({ params: { address }, authorize, admission, job }) => {
        let normalized: string;
        try {
          normalized = normalizeHandle(address);
        } catch {
          throw new ProblemError('not_found');
        }
        const current = await admission.run('normal', job, async () => {
          const claim = await withConnection(dependencies.pool, (client) => readSpaceAddress(client, normalized));
          if (!claim) return null;
          const route = routeOf(claim.spaceId);
          if (route === null) return null;
          const resource = { route, id: claim.spaceId };
          const check = await authorize({ ...resource, eligibility: spaceReadEligibility(resource) });
          return withConnection(dependencies.pool, async (client) => {
            if (!(await check(client))) return null;
            const space = await readSpace(client, claim.spaceId, observedAt());
            return space?.address === normalized ? space : null;
          });
        });
        if (!current) throw new ProblemError('not_found');
        published(current);
        return { spaceId: current.spaceId };
      },
    )
    .patch(
      '/v1/spaces/:spaceId',
      {
        params,
        headers: updateHeaders,
        body: strict(updateInput),
        response: {
          200: withHeaders(strict(spaceResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'space.update',
          'x-exposure': 'public',
          'x-action': 'space:manage',
          'x-resource-types': ['community.space'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { spaceId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await updateSpace(
              spaceDependencies(),
              actor,
              {
                spaceId,
                expectedHead,
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.summary === undefined ? {} : { summary: body.summary }),
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readSpaceForViewer(spaceDependencies(), actor, result.value.spaceId, observedAt(), {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = published(current, current.realmId);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { space: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms',
      {
        headers: commandHeaders,
        body: strict(createRealmInput),
        response: {
          201: withHeaders(strict(realmResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.create',
          'x-exposure': 'public',
          'x-action': 'realm:create',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await createRealm(
              realmDependencies(),
              actor,
              {
                spaceId: body.spaceId,
                title: body.title,
                ...(body.summary === undefined ? {} : { summary: body.summary }),
                visibility: body.visibility,
                contextId: body.contextId,
                ...(body.votes === undefined ? {} : { votes: body.votes }),
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/realms/${representation.realmId}`;
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId',
      {
        params: realmParams,
        response: {
          200: withHeaders(strict(realmResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'realm.get',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        const current = await admission.run('normal', job, () =>
          readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        const representation = publishedRealm(current);
        set.headers.etag = JSON.stringify(representation.headRevisionId);
        return { realm: representation };
      },
    )
    .get(
      '/v1/realms/:realmId/settings',
      {
        params: realmParams,
        response: {
          200: withHeaders(strict(RealmSettingsPageSchema), {
            etag: t.String(),
          }),
          ...readFailures,
        },
        detail: {
          operationId: 'realm.settings',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-resource-types': ['community.realm'],
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        const page = await admission.run('normal', job, () =>
          readRealmSettingsPage(realmDependencies(), actor, realmId, {
            deadline: job.deadline,
          }),
        );
        set.headers.etag = JSON.stringify(page.snapshot.head);
        set.headers['cache-control'] = 'private, no-store';
        return page;
      },
    )
    .get(
      '/v1/realms/:realmId/presentation',
      {
        params: realmParams,
        response: { 200: strict(t.Object({ community: CommunityPresentationSchema }, closed)), ...readFailures },
        detail: {
          operationId: 'realm.presentation',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job }) => {
        const community = await admission.run('normal', job, () =>
          readRealmHomePresentation(realmDependencies(), realmId, { actor, deadline: job.deadline }),
        );
        if (!community) throw new ProblemError('not_found');
        return { community: communityPresentationResponse(community) };
      },
    )
    .get(
      '/v1/realms/:realmId/participation',
      {
        params: realmParams,
        response: {
          204: t.Void(),
          ...readFailures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          503: problemSchema(
            'overloaded',
            'deadline_exceeded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'dependency_unavailable',
            'rate_limit_unavailable',
          ),
        },
        detail: {
          operationId: 'realm.participation',
          'x-exposure': 'public',
          'x-action': 'realm:participate',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        const allowed = await admission.run('normal', job, () =>
          createRealmParticipationCheck({ pool: dependencies.pool, access: dependencies.access() })(
            dependencies.pool as unknown as AccessClient,
            { realmId, actor },
          ),
        );
        if (!allowed) {
          const readable = await admission.run('normal', job, () =>
            readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
          );
          if (!readable) throw new ProblemError('not_found');
          throw new ProblemError('forbidden');
        }
        set.status = 204;
      },
    )
    .get(
      '/v1/realms/:realmId/claimRequests',
      {
        params: realmParams,
        query: claimReviewQuery,
        response: {
          200: strict(claimReviewResponse),
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'realm.claim_requests',
          'x-exposure': 'public',
          'x-action': 'realm:approve_claim',
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job }) =>
        admission.run('normal', job, async () => {
          const result = await listRealmClaimRequests(
            realmDependencies(),
            actor,
            { realmId, ...query },
            {
              deadline: job.deadline,
            },
          );
          return { ...result, claimRequests: [...result.claimRequests] };
        }),
    )
    .post(
      '/v1/realms/:realmId/claimRequests',
      {
        params: realmParams,
        headers: commandHeaders,
        body: strict(RealmClaimRequestInputSchema),
        response: {
          202: withHeaders(strict(RealmClaimRequestSchema), sessionHeader),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.claim_request',
          'x-exposure': 'public',
          'x-action': 'realm:participate',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await requestRealmClaim(realmDependencies(), actor, realmId, {
              idempotencyKey: key,
              deadline: job.deadline,
            });
            session.record(result);
            set.status = 202;
            return {
              ...result.value,
              orphanedAt: new Date(result.value.orphanedAt).toISOString(),
              claimEligibleAt: new Date(result.value.claimEligibleAt).toISOString(),
              requestedAt: new Date(result.value.requestedAt).toISOString(),
            };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/claimRequests/mine',
      {
        params: realmParams,
        response: {
          200: strict(realmClaimOwnPageResponse),
          ...readFailures,
        },
        detail: {
          operationId: 'realm.own_claim_request',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params, actor, admission, job }) => {
        return admission.run('normal', job, () =>
          readOwnRealmClaimPage(realmDependencies(), actor, params, { deadline: job.deadline }),
        );
      },
    )
    .get(
      '/v1/realms/:realmId/claimRequests/:requestId',
      {
        params: t.Object({ realmId: t.String(), requestId: t.String() }, closed),
        response: { 200: strict(realmClaimExactResponse), ...readFailures },
        detail: {
          operationId: 'realm.claim_request_status',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params, actor, admission, job }) => {
        const page = await admission.run('normal', job, () =>
          readOwnRealmClaimPage(realmDependencies(), actor, params, { deadline: job.deadline }),
        );
        if (!page.claimRequest) throw new ProblemError('not_found');
        return { ...page, claimRequest: page.claimRequest };
      },
    )
    .post(
      customMethod('/v1/realms/:realmId/claimRequests/:requestId', 'approve'),
      {
        params: t.Object({ realmId: t.String(), requestId: t.String() }, closed),
        headers: commandHeaders,
        response: {
          200: withHeaders(strict(realmClaimApprovalResponseSchema), sessionHeader),
          ...writeFailures,
        },
        detail: {
          operationId: 'realm.approve_claim',
          'x-exposure': 'public',
          'x-action': 'realm:approve_claim',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params, headers, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await approveRealmClaim(realmDependencies(), actor, params, {
              deadline: job.deadline,
              idempotencyKey: key,
            });
            return {
              claim: {
                ...result,
                orphanedAt: new Date(result.orphanedAt).toISOString(),
                approvedAt: new Date(result.approvedAt).toISOString(),
              },
            };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .patch(
      '/v1/realms/:realmId',
      {
        params: realmParams,
        headers: updateHeaders,
        body: strict(updateRealmInput),
        response: {
          200: withHeaders(strict(realmResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict', 'media_unavailable'),
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'realm.update',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await updateRealm(
              realmDependencies(),
              actor,
              {
                realmId,
                expectedHead,
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.summary === undefined ? {} : { summary: body.summary }),
                ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
                ...(body.contextId === undefined ? {} : { contextId: body.contextId }),
                ...(body.votes === undefined ? {} : { votes: body.votes }),
                ...(body.presentation === undefined ? {} : { presentation: body.presentation }),
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .put(
      '/v1/realms/:realmId/boardScheme',
      {
        params: realmParams,
        headers: updateHeaders,
        body: strict(t.Object({ schemeId: id }, closed)),
        response: {
          200: withHeaders(strict(realmResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'realm.board_scheme',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await setBoardScheme(
              realmDependencies(),
              actor,
              {
                realmId,
                expectedHead,
                schemeId: body.schemeId,
              },
              { idempotencyKey: key, deadline: job.deadline },
            );
            const current = await readRealm(realmDependencies(), actor, result.value.realmId, {
              deadline: job.deadline,
            });
            if (!current || current.headRevisionId !== result.value.revisionId) throw new ProblemError('not_found');
            const representation = publishedRealm(current);
            session.record(result);
            set.headers.etag = JSON.stringify(representation.headRevisionId);
            return { realm: representation };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/publications',
      {
        params: realmParams,
        headers: publicationHeaders,
        body: strict(t.Object({ subjectId: id }, closed)),
        response: {
          201: withHeaders(strict(publicationResponse), { ...sessionHeader, location: t.String(), etag: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict'),
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'publication.publish',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = headers['if-match'] === undefined ? undefined : matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await publish(
              realmDependencies(),
              actor,
              { realmId, subjectId: body.subjectId, ...(expectedHead === undefined ? {} : { expectedHead }) },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.status = 201;
            set.headers.location = `/v1/realms/${realmId}/publications/${body.subjectId}`;
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return { publication: publishedPublication(result.value) };
          });
        } catch (error) {
          if (error instanceof PublicationConflictError && expectedHead !== undefined)
            throw new ProblemError('precondition_failed');
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/publications',
      {
        params: realmParams,
        query: t.Object(
          {
            cursor: t.Optional(t.String()),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
          },
          closed,
        ),
        response: {
          200: strict(publicationPage),
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'publication.list',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job }) => {
        try {
          const page = await admission.run('normal', job, () =>
            listPublications(
              realmDependencies(),
              realmId,
              { actor, deadline: job.deadline },
              {
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: query.limit }),
              },
            ),
          );
          if (!page) throw new ProblemError('not_found');
          return { items: page.items.map(publishedPublication), next: page.next };
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/publicationShelf',
      {
        params: realmParams,
        query: strict(RealmHomePublicationQuerySchema),
        response: {
          200: strict(RealmHomePublicationPageSchema),
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          409: problemSchema('stale_cursor'),
        },
        detail: {
          operationId: 'realm.publicationShelf',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        try {
          const page = await admission.run('normal', job, () =>
            createRealmHomePublicationReader(realmDependencies())(realmId, { actor, deadline: job.deadline }, query),
          );
          if (!page) throw new ProblemError('not_found');
          return realmHomePublicationResponse(page);
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/publications/:subjectId/preparation',
      {
        params: publicationParams,
        response: {
          200: withHeaders(strict(PublicationPreparationResponseSchema), sessionHeader),
          ...readFailures,
        },
        detail: {
          operationId: 'publication.prepare',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const result = await admission.run('normal', job, () =>
          readPublicationPreparation(realmDependencies(), realmId, subjectId, { actor, deadline: job.deadline }),
        );
        if (!result) throw new ProblemError('not_found');
        for (const component of result.components) session.record(component);
        return { preparation: result.preparation };
      },
    )
    .get(
      '/v1/realms/:realmId/publications/:subjectId',
      {
        params: publicationParams,
        response: {
          200: withHeaders(strict(publicationResponse), { etag: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'publication.get',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, actor, admission, job, set }) => {
        const current = await admission.run('normal', job, () =>
          readPublication(realmDependencies(), realmId, subjectId, { actor, deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        set.headers.etag = JSON.stringify(current.publicationId);
        return { publication: publishedPublication(current) };
      },
    )
    .post(
      customMethod('/v1/realms/:realmId/publications/:subjectId', 'withdraw'),
      {
        params: publicationParams,
        headers: updateHeaders,
        response: {
          200: withHeaders(strict(decisionResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'publication.withdraw',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await withdraw(
              realmDependencies(),
              actor,
              { realmId, subjectId, expectedHead },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return {
              publication: {
                ...result.value,
                verdict: 'withdraw' as const,
                publishedAt: new Date(result.value.publishedAt).toISOString(),
              },
            };
          });
        } catch (error) {
          if (error instanceof PublicationConflictError) throw new ProblemError('precondition_failed');
          communityProblem(error);
        }
      },
    )
    .post(
      customMethod('/v1/realms/:realmId/publications/:subjectId', 'reject'),
      {
        params: publicationParams,
        headers: updateHeaders,
        response: {
          200: withHeaders(strict(decisionResponse), { ...sessionHeader, etag: t.String() }),
          ...writeFailures,
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'publication.reject',
          'x-exposure': 'public',
          'x-action': 'realm:publish',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId, subjectId }, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const expectedHead = matchHead(headers['if-match']);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await reject(
              realmDependencies(),
              actor,
              { realmId, subjectId, expectedHead },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            set.headers.etag = JSON.stringify(result.value.publicationId);
            return {
              publication: {
                ...result.value,
                verdict: 'reject' as const,
                publishedAt: new Date(result.value.publishedAt).toISOString(),
              },
            };
          });
        } catch (error) {
          if (error instanceof PublicationConflictError) throw new ProblemError('precondition_failed');
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/membership',
      {
        params: realmParams,
        headers: commandHeaders,
        response: { 202: strict(accepted), ...writeFailures },
        detail: {
          operationId: 'realm.join',
          'x-exposure': 'public',
          'x-action': 'realm:join',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, headers, actor, admission, job, authorize, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(realmId);
        if (route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!current) throw new ProblemError('not_found');
            if (current.visibility !== 'public') throw new ProblemError('forbidden');
            const allowed = await authorize({ route, id: realmId });
            if (!(await withConnection(dependencies.pool, (client) => allowed(client))))
              throw new ProblemError('forbidden');
            const result = await enqueueRealmJoin(await membershipDependencies(), {
              actor,
              realmId,
              spaceId: current.spaceId,
              memberAccountId: actor.accountId,
              idempotencyKey: key,
              deadline: job.deadline,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .delete(
      '/v1/realms/:realmId/membership',
      {
        params: realmParams,
        response: { 202: strict(accepted), ...writeFailures, 409: realmLeaveConflict },
        detail: {
          operationId: 'realm.leave',
          'x-exposure': 'public',
          'x-action': 'realm:join',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(realmId) === null) throw new ProblemError('not_found');
        try {
          return await admission.run('normal', job, async () => {
            const interval = await readRealmMembershipInterval(
              dependencies.pool,
              realmId,
              actor.accountId,
              observedAt(),
            );
            if (!interval) throw new ProblemError('not_found');
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!current) throw new ProblemError('not_found');
            const result = await enqueueRealmLeave(await membershipDependencies(), {
              actor,
              realmId,
              spaceId: current.spaceId,
              reservationId: interval.reservationId,
              deadline: job.deadline,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .post(
      '/v1/realms/:realmId/members',
      {
        params: realmParams,
        headers: commandHeaders,
        body: strict(addMemberInput),
        response: { 202: strict(accepted), ...writeFailures },
        detail: {
          operationId: 'realm.add_member',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, body, headers, actor, admission, job, authorize, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(body.accountId) === null) throw new ProblemError('invalid_request');
        const route = routeOf(realmId);
        if (route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const allowed = await authorize({ route, id: realmId });
            const granted = await withConnection(dependencies.pool, (client) => allowed(client));
            const current = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!granted) {
              if (!current) throw new ProblemError('not_found');
              throw new ProblemError('forbidden');
            }
            if (!current) throw new ProblemError('not_found');
            const result = await enqueueRealmJoin(await membershipDependencies(), {
              actor,
              realmId,
              spaceId: current.spaceId,
              memberAccountId: body.accountId,
              idempotencyKey: key,
              deadline: job.deadline,
            });
            set.status = 202;
            return result;
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/members/me',
      {
        params: realmParams,
        response: { 200: strict(membershipState), ...readFailures, 403: problemSchema('forbidden') },
        detail: {
          operationId: 'realm.membership',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(realmId) === null) throw new ProblemError('not_found');
        const current = await admission.run('normal', job, () =>
          readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline }),
        );
        if (!current) throw new ProblemError('not_found');
        return readOwnRealmMembership(dependencies.pool, realmId, actor.accountId, observedAt());
      },
    )
    .get(
      '/v1/realms/:realmId/members',
      {
        params: realmParams,
        query: memberPageQuery,
        response: {
          200: strict(memberPageResponse),
          ...readFailures,
          404: memberPageNotFound,
          403: memberPageForbidden,
          503: memberPageUnavailable,
          400: problemSchema('invalid_request', 'invalid_cursor', 'stale_cursor'),
        },
        detail: {
          operationId: 'realm.members',
          summary: 'List and inspect current Realm members',
          description:
            'Reads a bounded Realm management roster. The public exposure label makes the operation discoverable; current realm:manage authorization gates every roster read. A selected account is exact and does not advance the roster cursor.',
          'x-exposure': 'public',
          'x-action': 'realm:manage',
          'x-resource-types': ['community.realm'],
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job, authorize }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(realmId);
        if (route === null) throw new ProblemError('not_found');
        try {
          return await admission.run('normal', job, async () => {
            const currentRealm = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!currentRealm) throw new ProblemError('not_found');
            const managerCheck = await authorize({ route, id: realmId });
            const managerAllowed = await withConnection(dependencies.pool, (client) =>
              managerCheck(deadlineClient(client, job.deadline)),
            );
            if (!managerAllowed) throw new ProblemError('forbidden');

            const selection = await selectRealmMembers(
              { pool: dependencies.pool, tokens: dependencies.tokens, deadline: job.deadline },
              {
                realmId,
                viewerAccountId: actor.accountId,
                at: observedAt(),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.accountId === undefined ? {} : { selectedAccountId: query.accountId }),
              },
            );
            if (selection.state === 'preparing')
              return assertRealmMemberPageBytes({
                realmId,
                state: 'preparing' as const,
                items: [],
                next: selection.next,
                selected: null,
              });

            const accountIds = [
              ...selection.members.map((member) => member.accountId),
              ...(selection.selected === null ? [] : [selection.selected.accountId]),
            ];
            const identitiesBefore = await readRealmMemberIdentities(dependencies.pool, accountIds, job.deadline);
            const latestIdentities = await readRealmMemberIdentities(dependencies.pool, accountIds, job.deadline);
            // A changed identity anchor means this read crossed account replacement or deletion.
            // Withhold private roster data and let the caller retry the same raw cursor.
            if (
              accountIds.some(
                (accountId) => !sameIdentityAnchor(identitiesBefore.get(accountId), latestIdentities.get(accountId)),
              )
            )
              return assertRealmMemberPageBytes({
                realmId,
                state: 'preparing' as const,
                items: [],
                next: query.cursor ?? null,
                selected: null,
              });

            const checkBanPermission = async (): Promise<MemberBanPermission> => {
              try {
                const check = await accessCheck(
                  dependencies.access(),
                  actor,
                  'realm:ban',
                  { route, id: realmId },
                  { pool: dependencies.pool, deadline: job.deadline },
                );
                return await withConnection(dependencies.pool, (client) => check(deadlineClient(client, job.deadline)));
              } catch {
                return null;
              }
            };
            let banPermission = await checkBanPermission();
            let banObservations = new Map<string, { banned: boolean; protectedRole: boolean | null }>();
            if (banPermission) {
              banObservations = await readRealmMemberActions(
                { pool: dependencies.pool, deadline: job.deadline },
                { realmId, accountIds, at: observedAt() },
              );
              const finalBanPermission = await checkBanPermission();
              if (finalBanPermission !== true) {
                banPermission = finalBanPermission;
                banObservations = new Map();
              }
            }

            const stillCurrent = await confirmRealmMemberSelection(
              { pool: dependencies.pool, deadline: job.deadline },
              {
                realmId,
                at: observedAt(),
                members: selection.members,
                selected: selection.selected,
              },
            );
            if (!stillCurrent)
              return assertRealmMemberPageBytes({
                realmId,
                state: 'preparing' as const,
                items: [],
                next: query.cursor ?? null,
                selected: null,
              });

            const finalRealm = await readRealm(realmDependencies(), actor, realmId, { deadline: job.deadline });
            if (!finalRealm) throw new ProblemError('not_found');
            const finalManagerCheck = await authorize({ route, id: realmId });
            const finalManagerAllowed = await withConnection(dependencies.pool, (client) =>
              finalManagerCheck(deadlineClient(client, job.deadline)),
            );
            if (!finalManagerAllowed) throw new ProblemError('forbidden');

            const present = (accountId: string) => publicMemberIdentity(accountId, latestIdentities.get(accountId));
            const banState = (accountId: string) => {
              if (!banPermission) return 'unknown' as const;
              const action = banObservations.get(accountId);
              return action ? (action.banned ? ('banned' as const) : ('clear' as const)) : ('unknown' as const);
            };
            const items = selection.members.map((member) => {
              const identity = present(member.accountId);
              return {
                accountId: member.accountId,
                membership: 'member' as const,
                identity: identity.identity,
                displayName: identity.displayName,
                banState: banState(member.accountId),
                actions: memberActionAdvice({
                  realmId,
                  accountId: member.accountId,
                  membership: 'member',
                  identity: identity.identity,
                  banPermission,
                  ban: banObservations.get(member.accountId),
                }),
              };
            });
            const selected =
              selection.selected === null
                ? null
                : (() => {
                    const identity = present(selection.selected!.accountId);
                    return {
                      accountId: selection.selected!.accountId,
                      membership: selection.selected!.membership,
                      identity: identity.identity,
                      displayName: identity.displayName,
                      banState: banState(selection.selected!.accountId),
                      actions: memberActionAdvice({
                        realmId,
                        accountId: selection.selected!.accountId,
                        membership: selection.selected!.membership,
                        identity: identity.identity,
                        banPermission,
                        ban: banObservations.get(selection.selected!.accountId),
                      }),
                    };
                  })();
            return assertRealmMemberPageBytes({
              realmId,
              state: 'ready' as const,
              items,
              next: selection.next,
              selected,
            });
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .put(
      '/v1/realms/:realmId/bans/:accountId',
      {
        params: banParams,
        headers: commandHeaders,
        body: strict(t.Object({ reason: t.String({ maxLength: 1024 }) }, closed)),
        response: {
          200: withHeaders(strict(banResponse), sessionHeader),
          ...writeFailures,
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'realm.ban',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          return await admission.run('normal', job, async () => {
            const result = await banAccount(
              banDependencies(),
              actor,
              { ...params, reason: body.reason },
              { idempotencyKey: key, deadline: job.deadline },
            );
            session.record(result);
            return { ban: result.value };
          });
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .delete(
      '/v1/realms/:realmId/bans/:accountId',
      {
        params: banParams,
        headers: commandHeaders,
        response: { 204: t.Void(), ...writeFailures },
        detail: {
          operationId: 'realm.unban',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          await admission.run('normal', job, async () => {
            const result = await unbanAccount(banDependencies(), actor, params, {
              idempotencyKey: key,
              deadline: job.deadline,
            });
            session.record(result);
          });
          set.status = 204;
        } catch (error) {
          communityProblem(error);
        }
      },
    )
    .get(
      '/v1/realms/:realmId/bans',
      {
        params: realmParams,
        query: banQuery,
        response: {
          200: strict(banPage),
          ...readFailures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          503: writeFailures[503],
        },
        detail: {
          operationId: 'realm.bans',
          'x-exposure': 'public',
          'x-action': 'realm:ban',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        try {
          return await admission.run('normal', job, () =>
            listBans(banDependencies(), actor, realmId, { deadline: job.deadline }, query),
          );
        } catch (error) {
          communityProblem(error);
        }
      },
    );
}
