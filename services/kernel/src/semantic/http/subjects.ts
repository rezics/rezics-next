import { correctTerms, termRevision, StaleTermsRevisionError } from '../terms.ts';
import {
  changeStatementDisclosure,
  readStatementAs,
  StatementDisclosureConflictError,
  StatementDisclosureDeniedError,
  StatementDisclosureNotFoundError,
} from '../statement-disclosure.ts';
import { readSubjectSummaries, summaryAuthorization } from '../summaries.ts';
import { languageRanges } from '../language.ts';
import { CoverSummarySchema, SubjectSummarySchema } from './summaries.ts';
import { SourceSchema, BatchReferenceSchema } from '@rezics/definitions/bulk';
import { mergeSubjects, SubjectRedirectError } from '../merges.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { KeyRing } from '../../tokens/seal.ts';
import {
  adoptCandidates,
  decideCandidate,
  EditorialConflictError,
  listCandidates,
  listRevisions,
  proposeStatement,
  SubjectNotFoundError,
} from '../candidates.ts';
import { PageCursorError } from '../page.ts';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { isRelationProperty, relationSlotForApi, SubjectInputError, type Item, type Snak } from '../item.ts';
import { createSubject, readRelated, readSubject, SubjectAccessDeniedError, subjectTarget } from '../subject.ts';
import { DATA_TYPES, type DataType, type Release } from '@rezics/definitions';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { resourceAuthorization, type AuthorizationAnchor } from '../../access/resource-authorization.ts';
import { createResourceCreationManifest, parentCreationAuthorization } from '../../access/index.ts';
import { activeRelease, GLOBAL_CONTEXT, readRelease, StaleEditorialHeadError } from '../definitions.ts';
import { effectiveRelease } from '../extensions.ts';
import { termContext } from '@rezics/definitions/extension';
import { partitionOf, routeOf } from '../../route/route.ts';
import type { Access, AccountActor, Resource } from '../../request/access.ts';
import { accessCheck, AuthenticationError } from '../../request/access.ts';
import { readRevisionDetail } from '../revision-detail.ts';
import { createApp } from '../../http/app.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import { relatedReadEligibility, subjectReadEligibility } from '../eligibility.ts';
import { listSubjectLinks, listSubjectRelations, waitForSubjectLinks } from '../links.ts';
import { listSubjectGraph } from '../graph.ts';
import { readSubjectRelationCounts, type SubjectRelationCountResponse } from '../counts.ts';
import { customMethod } from '../../http/custom-method.ts';
import {
  moderateStatement,
  moderateSubject,
  ModerationConflictError,
  ModerationSubjectNotFoundError,
  readStatementCandidate,
  readSubjectVisibility,
} from '../moderation.ts';
import {
  ContextNotFoundError,
  editorialContextAnchor,
  globalContextAnchor,
  publicContextEligibility,
} from '../context.ts';
import { currentCommand, type CommandAuthorization, type CommandTransaction } from '../../command/command.ts';
import { REACTION_KINDS } from '../../content/events.ts';
import { readReactionCounts, type ReactionKind } from '../../content/reaction-projection.ts';
import readVisibility from '../read-visibility.sql';
import { AccountAgentLabelEditError, AccountAgentWriteDeniedError } from '../agents.ts';
import readRedirect from '../read-redirect.sql';
import { SourceRecordSchema } from '../source-records.ts';
import { revisionResource, StaleRevisionAuthorshipError } from '../authorship.ts';
import { requireAccessDeadline } from '../../access/unavailable.ts';
import { withReadTransaction } from '../read.ts';
import { readPartition } from '../../partition/partition.ts';
import readContributionLifecycleLocator from '../contribution-lifecycle-read-locator.sql';
import {
  contributionAuthorResource,
  deleteContribution,
  restoreContribution,
  ContributionLifecycleConflictError,
  ContributionLifecycleNotFoundError,
  SubjectPagePublicationUnavailableError,
} from '../contribution-lifecycle.ts';

const DataTypeSchema = t.Unsafe<DataType>(t.Union(DATA_TYPES.map((dataType) => t.Literal(dataType))));
const AgentSelfSourceSchema = t.Object(
  { kind: t.Literal('agent'), subject: t.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const SemanticSourceSchema = t.Union([SourceSchema, AgentSelfSourceSchema]);
const ValueSchema = t.Union([
  t.Object({ type: t.Literal('value'), content: t.Any() }, { additionalProperties: false }),
  t.Object({ type: t.Literal('somevalue') }, { additionalProperties: false }),
  t.Object({ type: t.Literal('novalue') }, { additionalProperties: false }),
]);
const SnakSchema = t.Object(
  {
    property: t.Object({ id: t.String(), data_type: DataTypeSchema }, { additionalProperties: false }),
    value: ValueSchema,
  },
  { additionalProperties: false },
);
const ReferenceSchema = t.Object({ parts: t.Array(SnakSchema), hash: t.String() }, { additionalProperties: false });
const StatementSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]),
    property: t.Object({ id: t.String(), data_type: DataTypeSchema }, { additionalProperties: false }),
    value: ValueSchema,
    qualifiers: t.Array(SnakSchema),
    references: t.Array(ReferenceSchema),
    rezics: t.Object({ release: t.String(), revision: t.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const ItemSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    revision: t.Integer({ minimum: 1 }),
    release: t.String(),
    context: t.String({ format: 'uuid' }),
    resolution: t.Record(t.String(), t.Any()),
    relationCounts: t.Record(t.String(), t.Integer({ minimum: 0 })),
    labels: t.Record(t.String(), t.String()),
    descriptions: t.Record(t.String(), t.String()),
    aliases: t.Record(t.String(), t.Array(t.String())),
    statements: t.Record(t.String(), t.Array(StatementSchema)),
    sourceRecords: t.Array(SourceRecordSchema),
  },
  { additionalProperties: false },
);

export const ItemInputSchema = t.Object(
  {
    type: t.String(),
    labels: t.Record(t.String(), t.Any()),
    descriptions: t.Optional(t.Record(t.String(), t.Any())),
    aliases: t.Optional(t.Record(t.String(), t.Any())),
    statements: t.Optional(t.Record(t.String(), t.Any())),
  },
  { additionalProperties: false },
);

export const TermsPatchSchema = t.Object(
  {
    labels: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Null()]))),
    descriptions: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Null()]))),
    aliases: t.Optional(t.Record(t.String(), t.Union([t.Array(t.String()), t.Null()]))),
  },
  { additionalProperties: false },
);
export const TermsResultSchema = t.Object(
  { subject: t.String({ format: 'uuid' }), revision: t.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

const revisionSelection = t.Object(
  {
    candidate: t.String({ format: 'uuid' }),
    rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]),
  },
  { additionalProperties: false },
);
const revisionReading = t.Object(
  {
    decision: t.Union([
      t.Null(),
      t.Object(
        {
          head: t.Integer({ minimum: 1 }),
          verdict: t.Union([t.Literal('accept'), t.Literal('reject'), t.Literal('abstain')]),
          revision: t.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ]),
    selected: t.Boolean(),
    rank: t.Union([t.Null(), t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]),
  },
  { additionalProperties: false },
);
const revisionCandidateFields = {
  candidate: t.String({ format: 'uuid' }),
  property: t.String(),
  context: t.String({ format: 'uuid' }),
  reading: revisionReading,
};
export const RevisionDetailSchema = t.Object(
  {
    subject: t.String({ format: 'uuid' }),
    revision: t.Object(
      { revision: t.Integer({ minimum: 1 }), kind: t.String(), release: t.String() },
      { additionalProperties: false },
    ),
    change: t.Union([
      t.Object({ kind: t.Literal('record') }, { additionalProperties: false }),
      t.Object(
        {
          kind: t.Literal('terms'),
          fields: t.Array(
            t.Object(
              {
                field: t.Union([t.Literal('labels'), t.Literal('descriptions'), t.Literal('aliases')]),
                languages: t.Array(t.String()),
              },
              { additionalProperties: false },
            ),
            { maxItems: 3 },
          ),
        },
        { additionalProperties: false },
      ),
      t.Object({ kind: t.Literal('candidate'), ...revisionCandidateFields }, { additionalProperties: false }),
      t.Object(
        {
          kind: t.Literal('decision'),
          ...revisionCandidateFields,
          head: t.Integer({ minimum: 1 }),
          verdict: t.Union([t.Literal('accept'), t.Literal('reject'), t.Literal('abstain')]),
        },
        { additionalProperties: false },
      ),
      t.Object(
        {
          kind: t.Literal('adoption'),
          property: t.String(),
          context: t.String({ format: 'uuid' }),
          head: t.Integer({ minimum: 1 }),
          mode: t.Union([t.Literal('inherit'), t.Literal('replace'), t.Literal('suppress')]),
          selection: t.Array(revisionSelection, { maxItems: 32 }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

const pageQuery = {
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
  cursor: t.Optional(t.String()),
};
function candidateError(error: unknown): never {
  if (error instanceof StatementDisclosureConflictError) throw new ProblemError('conflict');
  if (error instanceof StatementDisclosureDeniedError) throw new ProblemError('forbidden');
  if (error instanceof StatementDisclosureNotFoundError) throw new ProblemError('not_found');
  if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
  if (error instanceof SubjectRedirectError) throw new ProblemError('conflict');
  if (error instanceof SubjectNotFoundError) throw new ProblemError('not_found');
  if (error instanceof ContextNotFoundError) throw new ProblemError('not_found');
  if (error instanceof EditorialConflictError) throw new ProblemError('conflict');
  if (error instanceof StaleEditorialHeadError) throw new ProblemError('stale_editorial_head');
  if (error instanceof PageCursorError) throw new ProblemError('invalid_request');
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    throw new ProblemError('forbidden');
  if (error instanceof AccountAgentLabelEditError)
    throw new ProblemError('forbidden', {
      detail: 'Account agent labels are controlled by the account display name.',
      errors: [{ pointer: '/labels', code: 'unsupported' }],
    });
  if (error instanceof AccountAgentWriteDeniedError)
    throw new ProblemError('forbidden', {
      detail: `Only the account may state facts about this unverified account agent (${error.subject}).`,
    });
  throw error;
}
const listingErrors = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  503: problemSchema('semantic_not_ready', 'overloaded', 'deadline_exceeded'),
};
const LabelsSchema = t.Object(
  {
    labels: t.Record(t.String(), t.String()),
    redirect: t.Optional(t.String({ format: 'uuid' })),
    type: t.Optional(t.String()),
    types: t.Optional(t.Array(t.String())),
    cover: t.Optional(CoverSummarySchema),
  },
  { additionalProperties: false },
);
const redirectResponse = t.Object(
  {
    redirect: t.Object(
      { from: t.String({ format: 'uuid' }), to: t.String({ format: 'uuid' }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const itemResponse = t.Object({ subject: ItemSchema }, { additionalProperties: false });
const readResponse = t.Object(
  {
    subject: ItemSchema,
    account: t.Union([t.Object({ id: t.String({ format: 'uuid' }) }, { additionalProperties: false }), t.Null()]),
    summary: t.Union([SubjectSummarySchema, t.Null()]),
    related: t.Record(t.String(), LabelsSchema),
  },
  { additionalProperties: false },
);
const SubjectCountsSchema = t.Unsafe<SubjectRelationCountResponse>(
  t.Object(
    {
      properties: t.Optional(
        t.Record(
          t.String(),
          t.Union([
            t.Object(
              { out: t.Integer({ minimum: 1 }), in: t.Optional(t.Integer({ minimum: 1 })) },
              { additionalProperties: false },
            ),
            t.Object(
              { out: t.Optional(t.Integer({ minimum: 1 })), in: t.Integer({ minimum: 1 }) },
              { additionalProperties: false },
            ),
          ]),
        ),
      ),
      groups: t.Optional(
        t.Record(
          t.String(),
          t.Union([
            t.Object(
              { out: t.Integer({ minimum: 1 }), in: t.Optional(t.Integer({ minimum: 0 })) },
              { additionalProperties: false },
            ),
            t.Object(
              { out: t.Optional(t.Integer({ minimum: 0 })), in: t.Integer({ minimum: 1 }) },
              { additionalProperties: false },
            ),
          ]),
        ),
      ),
      content: t.Null(),
    },
    { additionalProperties: false },
  ),
);
const graphResponse = t.Object(
  {
    nodes: t.Array(
      t.Object(
        { id: t.String({ format: 'uuid' }), type: t.String(), label: t.String(), summary: SubjectSummarySchema },
        { additionalProperties: false },
      ),
    ),
    edges: t.Array(
      t.Object(
        {
          from: t.String({ format: 'uuid' }),
          property: t.String(),
          to: t.String({ format: 'uuid' }),
          statement: t.String({ format: 'uuid' }),
        },
        { additionalProperties: false },
      ),
    ),
    truncated: t.Array(
      t.Object(
        {
          node: t.String({ format: 'uuid' }),
          property: t.String(),
          direction: t.Union([t.Literal('out'), t.Literal('in')]),
          count: t.Optional(t.Integer({ minimum: 0 })),
          cursor: t.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const EditorialBodyContext = t.String({ format: 'uuid' });
const ExpectedHead = t.Union([t.Integer({ minimum: 1 }), t.Null()]);
const DecisionBody = t.Object(
  { context: EditorialBodyContext, expected_head: ExpectedHead },
  { additionalProperties: false },
);
const AdoptionMode = t.Union([t.Literal('inherit'), t.Literal('replace'), t.Literal('suppress')]);
const SelectionRank = t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]);
const Selection = t.Array(
  t.Object({ candidate: t.String({ format: 'uuid' }), rank: SelectionRank }, { additionalProperties: false }),
  { maxItems: 32 },
);
const AdoptionBody = t.Object(
  {
    context: EditorialBodyContext,
    property: t.String({ minLength: 1 }),
    target: t.Optional(t.String({ format: 'uuid' })),
    sameAs: t.Optional(t.String({ minLength: 1 })),
    key: t.Optional(t.String({ format: 'uuid' })),
    mode: AdoptionMode,
    selection: Selection,
    expected_head: ExpectedHead,
  },
  { additionalProperties: false },
);
const acceptanceResponse = t.Object(
  {
    acceptance: t.Object(
      {
        context: EditorialBodyContext,
        candidate: t.String({ format: 'uuid' }),
        decision: t.Union([t.Literal('accept'), t.Literal('reject')]),
        head: t.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const adoptionResponse = t.Object(
  {
    adoption: t.Object(
      {
        context: EditorialBodyContext,
        property: t.String(),
        mode: AdoptionMode,
        selection: t.Array(
          t.Object(
            {
              candidate: t.String({ format: 'uuid' }),
              rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]),
            },
            { additionalProperties: false },
          ),
          { maxItems: 32 },
        ),
        head: t.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ReasonModerationBody = t.Object(
  { reason: t.String({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false },
);
const Rfc3339 =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$';
const TakedownModerationBody = t.Object(
  {
    notice: t.Object(
      {
        complaint: t.String({ minLength: 1, maxLength: 2000 }),
        received_at: t.String({ pattern: Rfc3339 }),
        scope: t.Optional(t.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const visibilityResponse = t.Object(
  {
    subject: t.String({ format: 'uuid' }),
    visibility: t.Union([t.Literal('visible'), t.Literal('hidden'), t.Literal('taken_down')]),
    security_revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const statementVisibilityResponse = t.Object(
  {
    subject: t.String({ format: 'uuid' }),
    candidate: t.String({ format: 'uuid' }),
    visibility: t.Union([t.Literal('visible'), t.Literal('hidden'), t.Literal('taken_down')]),
    security_revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const cacheControl = { 'cache-control': t.Literal('no-cache') };
const reactionKind = t.Unsafe<ReactionKind>(t.Union(REACTION_KINDS.map((kind) => t.Literal(kind))));
const reactionCountResponse = t.Object(
  {
    counts: t.Array(
      t.Object({ kind: reactionKind, count: t.Integer({ minimum: 1 }) }, { additionalProperties: false }),
    ),
    watermark: t.Union([
      t.Object(
        { epoch: t.Integer({ minimum: 1 }), position: t.String({ pattern: '^[1-9][0-9]*$' }) },
        { additionalProperties: false },
      ),
      t.Null(),
    ]),
  },
  { additionalProperties: false },
);
type SubjectRouteDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  tokens: KeyRing;
  access: () => Access;
  clock: () => Date;
};
function invalidSubjectInput(error: SubjectInputError): ProblemError {
  return new ProblemError('invalid_request', { errors: error.violations });
}

function relationSlotAddress(
  subject: string,
  property: string,
  release: Release,
  input: { target?: string; sameAs?: string; key?: string },
): string {
  const fail = (pointers: string[]) =>
    new SubjectInputError(pointers.map((pointer) => ({ pointer: `/${pointer}`, code: 'invalid_format' as const })));
  const relation = release.properties[property]?.relation;
  const isRelation = isRelationProperty(release, property);
  if (input.target !== undefined && input.sameAs !== undefined) throw fail(['target', 'sameAs']);
  if (!isRelation && (input.target !== undefined || input.sameAs !== undefined || input.key !== undefined))
    throw fail([input.target !== undefined ? 'target' : input.sameAs !== undefined ? 'sameAs' : 'key']);
  if (input.target !== undefined && routeOf(input.target) === null) throw fail(['target']);
  if (input.sameAs !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(input.sameAs)) throw fail(['sameAs']);
  if (input.key !== undefined && (input.target === undefined || !relation?.slotKey || routeOf(input.key) === null))
    throw fail(['key']);
  return relationSlotForApi(subject, property, relation, input);
}

type CommandAuthorizer = (resource: Resource, denied: () => Error) => Promise<CommandAuthorization>;

async function authorizeSemanticWrite(input: {
  access: Access;
  actor: AccountActor;
  action: string;
  anchor: AuthorizationAnchor;
  pool: Pool;
  deadline: number;
  targetPartition: number;
  authorizeCommand: CommandAuthorizer;
  denied: () => Error;
}): Promise<CommandAuthorization> {
  if (partitionOf(input.anchor.resource.route) === input.targetPartition)
    return input.authorizeCommand(input.anchor.resource, input.denied);
  return resourceAuthorization({
    access: input.access,
    actor: input.actor,
    action: input.action,
    anchor: input.anchor,
    context: { pool: input.pool, deadline: input.deadline, partition: input.targetPartition },
  });
}

function moderationError(error: unknown): never {
  if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
  if (error instanceof ModerationSubjectNotFoundError) throw new ProblemError('not_found');
  if (error instanceof ModerationConflictError) throw new ProblemError('conflict');
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    throw new ProblemError('forbidden');
  throw error;
}

function relatedIds(subject: Item): { propertyIds: Set<string>; subjectIds: Set<string> } {
  const propertyIds = new Set<string>();
  const subjectIds = new Set<string>();
  const visit = (snak: Snak) => {
    propertyIds.add(snak.property.id);
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      typeof snak.value.content === 'string'
    )
      subjectIds.add(snak.value.content);
  };
  for (const [property, statements] of Object.entries(subject.statements)) {
    propertyIds.add(property);
    for (const statement of statements) {
      statement.qualifiers.forEach(visit);
      statement.references.forEach((reference) => reference.parts.forEach(visit));
      if (
        statement.property.data_type === 'wikibase-item' &&
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string'
      )
        subjectIds.add(statement.value.content);
    }
  }
  return { propertyIds, subjectIds };
}

function subjectRoutes(
  app: ReturnType<typeof createApp>,
  { pool, routeKey, tokens, access, clock }: SubjectRouteDependencies,
) {
  function contributionAuthorization(
    actor: AccountActor,
    action: 'statement:delete' | 'statement:restore',
    resource: Resource,
    deadline: number,
    includeGlobalPropose: boolean,
  ): CommandAuthorization {
    const context = { pool, deadline, partition: partitionOf(resource.route) };
    const author = resourceAuthorization({
      access: access(),
      actor,
      action,
      anchor: {
        resource,
        async validate(client) {
          const result = await client.query(
            `SELECT 1 FROM access.resource_initialization
             WHERE route=$1 AND resource_id=$2 AND resource_type='semantic.revision'`,
            [resource.route, resource.id],
          );
          return result.rows.length === 1;
        },
      },
      context,
    });
    if (!includeGlobalPropose) return author;
    const proposal = resourceAuthorization({
      access: access(),
      actor,
      action: 'statement:propose',
      anchor: globalContextAnchor,
      context,
    });
    return {
      action,
      resource: author.resource,
      denied: () => new GrantDeniedError(),
      async prepare(attempt) {
        const authorProof = await author.prepare!(attempt);
        const proposalProof = await proposal.prepare!(attempt);
        return { authorProof, proposalProof };
      },
      async authorize(tx, attempt, proof) {
        const prepared = proof as { authorProof: unknown; proposalProof: unknown };
        await author.authorize(tx, attempt, prepared.authorProof);
        await proposal.authorize(tx, attempt, prepared.proposalProof);
        return 'execute';
      },
    };
  }
  const nativeCreationEntry = (
    resource: Resource,
    type: string,
    accountId: string,
    subject: string,
    revision: number,
  ) => ({
    resource,
    type,
    creator: accountId,
    creation: {
      async validate(client: CommandTransaction, candidate: Readonly<Resource>): Promise<boolean> {
        const command = currentCommand(client);
        if (
          candidate.route !== resource.route ||
          candidate.id !== resource.id ||
          command.basis?.actorAccountId !== accountId ||
          command.authorization?.mode !== 'execute'
        )
          return false;
        if (type === 'semantic.subject') {
          const result = await client.query(
            `SELECT 1 FROM semantic.subject s
             JOIN semantic.revision r ON r.route=s.route AND r.subject_id=s.subject_id AND r.revision=1
               AND r.recorded_transaction_id=s.recorded_transaction_id AND r.kind='create'
             WHERE s.route=$1 AND s.subject_id=$2 AND s.recorded_transaction_id=$3::uuid`,
            [resource.route, subject, command.transactionId],
          );
          return result.rows.length === 1;
        }
        const result = await client.query(
          `SELECT 1 FROM semantic.revision r
           WHERE r.route=$1 AND r.subject_id=$2 AND r.revision=$3
             AND r.kind IN ('create','propose','terms') AND r.recorded_transaction_id=$4::uuid`,
          [resource.route, subject, revision, command.transactionId],
        );
        return result.rows.length === 1;
      },
    },
  });
  return app
    .post(
      '/v1/subjects',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ItemInputSchema,
        response: {
          201: withHeaders(itemResponse, { [SESSION_HEADER]: t.String(), location: t.String(), etag: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.create',
          'x-exposure': 'public',
          'x-action': 'subject:create',
          'x-resource-types': ['semantic.subject', 'semantic.revision'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const account: AccountActor = actor;
        const active = await effectiveRelease(pool, GLOBAL_CONTEXT, true);
        if (!active) throw new ProblemError('semantic_not_ready');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const target = subjectTarget(routeKey, account.accountId, key);
        const firstRevision = revisionResource(target.id, 1);
        const manifest = createResourceCreationManifest([
          nativeCreationEntry(target, 'semantic.subject', account.accountId, target.id, 1),
          nativeCreationEntry(firstRevision, 'semantic.revision', account.accountId, target.id, 1),
        ]);
        const authorization = parentCreationAuthorization({
          access: access(),
          actor: account,
          action: 'subject:create',
          parent: globalContextAnchor,
          context: {
            pool,
            deadline: job.deadline,
            resource: target,
            creation: nativeCreationEntry(target, 'semantic.subject', account.accountId, target.id, 1).creation,
            manifest,
          },
        });
        try {
          const result = await admission.run('normal', job, () =>
            createSubject(pool, {
              actor: account,
              target,
              idempotencyKey: key,
              digest: requestDigest('subject.create', account, body),
              item: body,
              release: { digest: active.digest, release: active.release },
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          set.status = 201;
          set.headers.location = `/v1/subjects/${result.subject.id}`;
          set.headers.etag = `"${result.subject.revision}"`;
          return { subject: result.subject };
        } catch (error) {
          if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
          if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
            throw new ProblemError('forbidden');
          if (error instanceof AccountAgentLabelEditError)
            throw new ProblemError('forbidden', {
              detail: 'Account agent labels are controlled by the account display name.',
              errors: [{ pointer: '/labels', code: 'unsupported' }],
            });
          if (error instanceof AccountAgentWriteDeniedError)
            throw new ProblemError('forbidden', {
              detail: `Only the account may state facts about this unverified account agent (${error.subject}).`,
            });
          throw error;
        }
      },
    )
    .patch(
      '/v1/subjects/:id/terms',
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({
          [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }),
          'if-match': t.String(),
        }),
        body: TermsPatchSchema,
        response: {
          200: withHeaders(TermsResultSchema, { [SESSION_HEADER]: t.String(), etag: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          412: problemSchema('precondition_failed'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.terms',
          'x-exposure': 'public',
          'x-action': 'statement:propose',
          'x-resource-types': ['semantic.revision'],
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        try {
          const expectedRevision = termRevision(headers['if-match']);
          const anchor = revisionResource(params.id, expectedRevision + 1);
          const entry = nativeCreationEntry(
            anchor,
            'semantic.revision',
            actor.accountId,
            params.id,
            expectedRevision + 1,
          );
          const authorization = parentCreationAuthorization({
            access: access(),
            actor,
            action: 'statement:propose',
            parent: globalContextAnchor,
            context: {
              pool,
              deadline: job.deadline,
              resource: anchor,
              creation: entry.creation,
              manifest: createResourceCreationManifest([entry]),
            },
          });
          const noEffectAuthorization = resourceAuthorization({
            access: access(),
            actor,
            action: 'statement:propose',
            anchor: globalContextAnchor,
            context: { pool, deadline: job.deadline, partition: partitionOf(route) },
          });
          const result = await admission.run('normal', job, () =>
            correctTerms(pool, {
              subject: params.id,
              expectedRevision,
              patch: body,
              actor,
              authorization,
              noEffectAuthorization,
              prepareSubject: () =>
                accessCheck(
                  access(),
                  actor,
                  'subject:read',
                  { route, id: params.id, eligibility: subjectReadEligibility({ route, id: params.id }) },
                  { pool, deadline: job.deadline },
                ),
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.terms', actor, { subject: params.id, expectedRevision, body }),
              routeKey,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          set.headers.etag = `"${result.revision}"`;
          return { subject: result.subject, revision: result.revision };
        } catch (error) {
          if (error instanceof StaleTermsRevisionError) throw new ProblemError('precondition_failed');
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects', 'merge'),
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Object(
          { subjects: t.Array(t.String({ format: 'uuid' }), { minItems: 2, maxItems: 2 }) },
          { additionalProperties: false },
        ),
        response: {
          200: withHeaders(
            t.Object(
              {
                survivor: t.String({ format: 'uuid' }),
                redirected: t.String({ format: 'uuid' }),
                revision: t.Integer({ minimum: 2 }),
              },
              { additionalProperties: false },
            ),
            { [SESSION_HEADER]: t.String() },
          ),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.merge',
          'x-exposure': 'gate:subject_identity',
          'x-action': 'subject:merge',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const [, redirected] = [...body.subjects].sort();
        const commandRoute = routeOf(redirected!);
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'subject:merge',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: commandRoute === null ? 0 : partitionOf(commandRoute),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            mergeSubjects(pool, {
              subjects: body.subjects,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.merge', actor, body),
              release: active,
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(component);
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ context: t.Optional(EditorialBodyContext), language: t.Optional(t.String()) }),
        response: {
          200: withHeaders(readResponse, { [SESSION_HEADER]: t.String(), etag: t.String(), ...cacheControl }),
          308: withHeaders(redirectResponse, { location: t.String() }),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.get',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, actor, authorize, admission, job, session, set, request }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const languages = languageRanges(request.headers.get('accept-language'), query.language);
        const authorizeSummary = summaryAuthorization(async (id, batch) => {
          const route = routeOf(id)!;
          return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
        });
        const result = await admission.run('normal', job, () =>
          readSubject(pool, params.id, async () => false, query.context ?? GLOBAL_CONTEXT, routeKey, {
            languages,
            authorize: authorizeSummary,
            seen: [...session.components],
            deadline: job.deadline,
            prepareAuthorize: (id) => {
              const resource = { route: routeOf(id)!, id };
              return authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
            },
            readAs: (read) => readStatementAs(pool, access(), actor, job.deadline, read),
          }).catch((error: unknown) => {
            if (error instanceof SubjectRedirectError) return error;
            throw error;
          }),
        );
        if (!result) throw new ProblemError('not_found');
        if (result instanceof SubjectRedirectError) {
          set.status = 308;
          set.headers.location = `/v1/subjects/${result.to}${new URL(request.url).search}`;
          return { redirect: { from: result.from, to: result.to } };
        }

        const release = await readRelease(pool, result.subject.release);
        if (!release) throw new Error('Subject revision release is missing');
        const { propertyIds, subjectIds } = relatedIds(result.subject);
        const related: Record<
          string,
          {
            labels: Record<string, string>;
            redirect?: string;
            type?: string;
            types?: string[];
            cover?: import('../summaries.ts').CoverSummary | null;
          }
        > = {};
        for (const property of propertyIds) {
          const definition = release.properties[property];
          if (definition) related[property] = { labels: definition.labels };
        }
        const relatedList = [...subjectIds];
        if (relatedList.length > 256) throw new TypeError('A related read accepts at most 256 ids');
        const checks = await Promise.all(
          relatedList.map(async (id) => {
            const relatedRoute = routeOf(id);
            if (relatedRoute === null) return null;
            const relatedResource = { route: relatedRoute, id };
            return authorize({
              ...relatedResource,
              eligibility: relatedReadEligibility(relatedResource, relatedList),
            });
          }),
        );
        const references = await admission.run('normal', job, () =>
          withConnection(pool, async (client) => {
            const allowed: string[] = [];
            for (let index = 0; index < relatedList.length; index++) {
              const check = checks[index];
              const id = relatedList[index];
              if (!check || id === undefined || !(await check(client))) continue;
              allowed.push(id);
            }
            return readRelated(client, allowed);
          }),
        );
        const active = await activeRelease(pool);
        const summaries = active
          ? await readSubjectSummaries(
              {
                client: { query: pool.query.bind(pool) },
                pool,
                routeKey,
                deadline: job.deadline,
                release: active.release,
                authorize: authorizeSummary,
              },
              Object.entries(references).map(([id, value]) => value.redirect ?? id),
              { languages },
            )
          : new Map();
        for (const [id, reference] of Object.entries(references)) {
          const summary = summaries.get(reference.redirect ?? id);
          if (summary) related[id] = { ...reference, type: summary.type, types: summary.types, cover: summary.cover };
        }

        session.record(result.component);
        set.headers.etag = `"${result.subject.revision}"`;
        set.headers['cache-control'] = 'no-cache';
        return { subject: result.subject, account: result.account, summary: result.summary, related };
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'hide'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.hide',
          'x-exposure': 'public',
          'x-action': 'moderation:hide',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:hide',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(route),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'hide',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.hide', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'takedown'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: TakedownModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.take_down',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:takedown',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(route),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'take_down',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.take_down', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'restore'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.restore',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:takedown',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(routeOf(params.id)!),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'restore',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.restore', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      '/v1/subjects/:id/candidates',
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Object({ statement: t.Any() }, { additionalProperties: false }),
        response: {
          201: withHeaders(t.Object({ candidate: t.String({ format: 'uuid' }), revision: t.Integer({ minimum: 1 }) }), {
            [SESSION_HEADER]: t.String(),
          }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.propose',
          'x-exposure': 'public',
          'x-action': 'statement:propose',
          'x-resource-types': ['semantic.revision'],
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const subjectRoute = routeOf(params.id);
        if (subjectRoute === null) throw new ProblemError('not_found');
        const property = (body.statement as { property?: { id?: unknown } }).property?.id;
        const owner = typeof property === 'string' ? termContext(property) : null;
        let active = await effectiveRelease(pool, GLOBAL_CONTEXT, true);
        // A Context's relation type is proposed with the release that Context sees.
        if (active && owner && !Object.hasOwn(active.release.properties, property as string))
          active = await effectiveRelease(pool, owner, true);
        if (!active) throw new ProblemError('semantic_not_ready');
        // Rebuild the entire declaration and authorization after a native revision collision.
        // A serialization retry inside runCommand also reaches the same body check.
        for (;;) {
          requireAccessDeadline(job.deadline);
          const current = await withReadTransaction(pool, async (client) => {
            await readPartition(client, partitionOf(subjectRoute));
            const result = await client.query<{ revision: number }>(
              `SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2
             ORDER BY revision DESC LIMIT 1`,
              [subjectRoute, params.id],
            );
            return result.rows[0]?.revision;
          });
          if (current === undefined) throw new ProblemError('not_found');
          const nextRevision = current + 1;
          const anchor = revisionResource(params.id, nextRevision);
          const manifest = createResourceCreationManifest([
            nativeCreationEntry(anchor, 'semantic.revision', actor.accountId, params.id, nextRevision),
          ]);
          const authorization = parentCreationAuthorization({
            access: access(),
            actor,
            action: 'statement:propose',
            parent: globalContextAnchor,
            context: {
              pool,
              deadline: job.deadline,
              resource: anchor,
              creation: nativeCreationEntry(anchor, 'semantic.revision', actor.accountId, params.id, nextRevision)
                .creation,
              manifest,
            },
          });
          try {
            const result = await admission.run('normal', job, () =>
              proposeStatement(pool, {
                subject: params.id,
                statement: body.statement,
                actor,
                idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
                digest: requestDigest('subject.propose', actor, { subject: params.id, body }),
                release: active,
                authorization,
                expectedRevision: nextRevision,
                deadline: job.deadline,
                clock,
              }),
            );
            session.record(result.component);
            set.status = 201;
            return { candidate: result.candidate, revision: result.revision };
          } catch (error) {
            if (error instanceof StaleRevisionAuthorshipError) continue;
            return candidateError(error);
          }
        }
      },
    )
    .delete(
      '/v1/subjects/:id/candidates/:candidate',
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Optional(t.Object({}, { additionalProperties: false })),
        response: {
          200: withHeaders(
            t.Object({
              subject: t.String({ format: 'uuid' }),
              candidate: t.String({ format: 'uuid' }),
              deleted: t.Boolean(),
            }),
            {
              [SESSION_HEADER]: t.String(),
            },
          ),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'statement.delete',
          'x-exposure': 'public',
          'x-action': 'statement:delete',
          'x-resource-types': ['semantic.revision'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, headers, body: _body, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null || routeOf(params.candidate) !== route) throw new ProblemError('not_found');
        const located = await admission.run('normal', job, () =>
          withConnection(pool, (client) =>
            readContributionLifecycleLocator.run(client, {
              route,
              subject_id: params.id,
              candidate_id: params.candidate,
            }),
          ),
        );
        if (!located) throw new ProblemError('not_found');
        const resource = contributionAuthorResource(params.id, located.revision);
        try {
          const result = await admission.run('normal', job, () =>
            deleteContribution(pool, {
              subject: params.id,
              candidate: params.candidate,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              authorization: contributionAuthorization(actor, 'statement:delete', resource, job.deadline, false),
              routeKey,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return { subject: result.subject, candidate: result.candidate, deleted: result.deleted };
        } catch (error) {
          if (error instanceof ContributionLifecycleNotFoundError) throw new ProblemError('not_found');
          if (error instanceof ContributionLifecycleConflictError) throw new ProblemError('conflict');
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          if (error instanceof SubjectPagePublicationUnavailableError) throw new ProblemError('semantic_not_ready');
          throw error;
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'restoreDeleted'),
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Object({}, { additionalProperties: false }),
        response: {
          200: withHeaders(
            t.Object({
              subject: t.String({ format: 'uuid' }),
              candidate: t.String({ format: 'uuid' }),
              deleted: t.Boolean(),
            }),
            {
              [SESSION_HEADER]: t.String(),
            },
          ),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'statement.restore_deleted',
          'x-exposure': 'public',
          'x-action': 'statement:restore',
          'x-resource-types': ['semantic.revision'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, headers, body: _body, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null || routeOf(params.candidate) !== route) throw new ProblemError('not_found');
        const located = await admission.run('normal', job, () =>
          withConnection(pool, (client) =>
            readContributionLifecycleLocator.run(client, {
              route,
              subject_id: params.id,
              candidate_id: params.candidate,
            }),
          ),
        );
        if (!located) throw new ProblemError('not_found');
        const resource = contributionAuthorResource(params.id, located.revision);
        try {
          const result = await admission.run('normal', job, () =>
            restoreContribution(pool, {
              subject: params.id,
              candidate: params.candidate,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              authorization: contributionAuthorization(actor, 'statement:restore', resource, job.deadline, true),
              routeKey,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return { subject: result.subject, candidate: result.candidate, deleted: result.deleted };
        } catch (error) {
          if (error instanceof ContributionLifecycleNotFoundError) throw new ProblemError('not_found');
          if (error instanceof ContributionLifecycleConflictError) throw new ProblemError('conflict');
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          if (error instanceof SubjectPagePublicationUnavailableError) throw new ProblemError('semantic_not_ready');
          throw error;
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'accept'),
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: DecisionBody,
        response: {
          200: withHeaders(acceptanceResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.accept_candidate',
          'x-exposure': 'public',
          'x-action': 'context:accept',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const subjectRoute = routeOf(params.id);
        if (subjectRoute === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'context:accept',
          anchor: editorialContextAnchor(body.context),
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(subjectRoute),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const { component, acceptance, revision } = await admission.run('normal', job, () =>
            decideCandidate(pool, {
              routeKey,
              subject: params.id,
              candidate: params.candidate,
              decision: 'accept',
              context: body.context,
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.decide', actor, {
                subject: params.id,
                candidate: params.candidate,
                decision: 'accept',
                body,
              }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(component);
          return { acceptance, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'reject'),
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: DecisionBody,
        response: {
          200: withHeaders(acceptanceResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.reject_candidate',
          'x-exposure': 'public',
          'x-action': 'context:accept',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const subjectRoute = routeOf(params.id);
        if (subjectRoute === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'context:accept',
          anchor: editorialContextAnchor(body.context),
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(subjectRoute),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const { component, acceptance, revision } = await admission.run('normal', job, () =>
            decideCandidate(pool, {
              routeKey,
              subject: params.id,
              candidate: params.candidate,
              decision: 'reject',
              context: body.context,
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.decide', actor, {
                subject: params.id,
                candidate: params.candidate,
                decision: 'reject',
                body,
              }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(component);
          return { acceptance, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'hide'),
      {
        params: t.Object({ id: t.String(), candidate: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(statementVisibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'statement.hide',
          'x-exposure': 'public',
          'x-action': 'moderation:hide',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null || routeOf(params.candidate) !== routeOf(params.id))
          throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () =>
          readStatementCandidate(pool, params.id, params.candidate),
        );
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:hide',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(routeOf(params.id)!),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateStatement(pool, {
              routeKey,
              actor,
              subject: params.id,
              candidate: params.candidate,
              action: 'hide',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('statement.hide', actor, {
                subject: params.id,
                candidate: params.candidate,
                body,
              }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            candidate: result.candidate,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'takedown'),
      {
        params: t.Object({ id: t.String(), candidate: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: TakedownModerationBody,
        response: {
          200: withHeaders(statementVisibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'statement.take_down',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null || routeOf(params.candidate) !== routeOf(params.id))
          throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () =>
          readStatementCandidate(pool, params.id, params.candidate),
        );
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:takedown',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(routeOf(params.id)!),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateStatement(pool, {
              routeKey,
              actor,
              subject: params.id,
              candidate: params.candidate,
              action: 'take_down',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('statement.take_down', actor, {
                subject: params.id,
                candidate: params.candidate,
                body,
              }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            candidate: result.candidate,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'restore'),
      {
        params: t.Object({ id: t.String(), candidate: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(statementVisibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'statement.restore',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null || routeOf(params.candidate) !== routeOf(params.id))
          throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () =>
          readStatementCandidate(pool, params.id, params.candidate),
        );
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'moderation:takedown',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(routeOf(params.id)!),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            moderateStatement(pool, {
              routeKey,
              actor,
              subject: params.id,
              candidate: params.candidate,
              action: 'restore',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('statement.restore', actor, {
                subject: params.id,
                candidate: params.candidate,
                body,
              }),
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            candidate: result.candidate,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'adopt'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: AdoptionBody,
        response: {
          200: withHeaders(adoptionResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.adopt',
          'x-exposure': 'public',
          'x-action': 'context:adopt',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const active = await effectiveRelease(pool, body.context, true);
        if (!active) throw new ProblemError('semantic_not_ready');
        const slot = relationSlotAddress(params.id, body.property, active.release, body);
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'context:adopt',
          anchor: editorialContextAnchor(body.context),
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(routeOf(params.id)!),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const { component, adoption, revision } = await admission.run('normal', job, () =>
            adoptCandidates(pool, {
              routeKey,
              subject: params.id,
              context: body.context,
              property: body.property,
              slot,
              mode: body.mode,
              selection: body.selection as { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[],
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.adopt', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
              release: active,
              clock,
            }),
          );
          session.record(component);
          return { adoption, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/candidates',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          ...pageQuery,
          property: t.String({ minLength: 1 }),
          context: t.Optional(EditorialBodyContext),
          target: t.Optional(t.String({ format: 'uuid' })),
          sameAs: t.Optional(t.String({ minLength: 1 })),
          key: t.Optional(t.String({ format: 'uuid' })),
        }),
        response: {
          200: withHeaders(
            t.Object({
              candidates: t.Array(
                t.Union([
                  t.Object(
                    { id: t.String({ format: 'uuid' }), deleted: t.Literal(true) },
                    { additionalProperties: false },
                  ),
                  t.Object(
                    {
                      id: t.String({ format: 'uuid' }),
                      source: t.Union([SemanticSourceSchema, t.Null()]),
                      retracted: t.Union([t.Integer(), t.Null()]),
                      retraction: t.Union([
                        t.Object({ source: SemanticSourceSchema, references: t.Array(BatchReferenceSchema) }),
                        t.Null(),
                      ]),
                      consentIdentity: t.Optional(
                        t.Object({
                          subject: t.Union([
                            t.Object({ id: t.String(), labels: t.Record(t.String(), t.String()) }),
                            t.Null(),
                          ]),
                          target: t.Union([
                            t.Object({
                              id: t.String(),
                              labels: t.Record(t.String(), t.String()),
                              redirect: t.Optional(t.String()),
                            }),
                            t.Null(),
                          ]),
                        }),
                      ),
                      statement: StatementSchema,
                      release: t.String(),
                      revision: t.Integer(),
                      decision: t.Union([
                        t.Literal('accepted'),
                        t.Literal('rejected'),
                        t.Literal('abstained'),
                        t.Null(),
                      ]),
                      head: t.Union([t.Integer(), t.Null()]),
                      rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated'), t.Null()]),
                    },
                    { additionalProperties: false },
                  ),
                ]),
              ),
              adoption: t.Union([
                t.Object({
                  mode: t.Union([t.Literal('inherit'), t.Literal('replace'), t.Literal('suppress')]),
                  head: t.Integer(),
                }),
                t.Null(),
              ]),
              next: t.Union([t.String(), t.Null()]),
            }),
            { 'cache-control': t.Union([t.Literal('no-cache'), t.Literal('private, no-store')]) },
          ),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.list_candidates',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, actor, authorize, admission, job, session, set }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const active = await effectiveRelease(pool, query.context ?? GLOBAL_CONTEXT);
        if (!active) throw new ProblemError('semantic_not_ready');
        if (!Object.hasOwn(active.release.properties, query.property)) throw new ProblemError('invalid_request');
        const slot = relationSlotAddress(params.id, query.property, active.release, query);
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            readStatementAs(pool, access(), actor, job.deadline, (refreshAudience) =>
              listCandidates(pool, tokens, {
                subject: params.id,
                property: query.property,
                slot,
                context: query.context ?? GLOBAL_CONTEXT,
                limit: query.limit ?? 20,
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                authorize: check,
                routeKey,
                identity: {
                  access: access(),
                  actor,
                  deadline: job.deadline,
                  refreshAudience,
                  prepareSource: () => authorize({ ...resource, eligibility: subjectReadEligibility(resource) }),
                },
              }),
            ),
          );
          session.record(component);
          set.headers['cache-control'] = actor.kind === 'account' ? 'private, no-store' : 'no-cache';
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/revisions/:revision',
      {
        params: t.Object({ id: t.String(), revision: t.Numeric({ minimum: 1, maximum: 2147483647, multipleOf: 1 }) }),
        response: { 200: withHeaders(RevisionDetailSchema, cacheControl), ...listingErrors },
        detail: {
          operationId: 'subject.read_revision',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, actor, authorize, admission, job, session, set }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            readStatementAs(pool, access(), actor, job.deadline, () =>
              readRevisionDetail(pool, {
                subject: params.id,
                revision: params.revision,
                routeKey,
                authorize: check,
                authorizeContext: async (context) => {
                  const target = { route: routeOf(context)!, id: context };
                  return accessCheck(
                    access(),
                    actor,
                    'context:read',
                    { ...target, eligibility: publicContextEligibility(target) },
                    { pool, deadline: job.deadline },
                  );
                },
                authorizeRelated: async (id) => {
                  const target = { route: routeOf(id)!, id };
                  return authorize({ ...target, eligibility: subjectReadEligibility(target) });
                },
              }),
            ),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/revisions',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object(pageQuery),
        response: {
          200: withHeaders(
            t.Object({
              revisions: t.Array(
                t.Object({
                  revision: t.Integer(),
                  kind: t.String(),
                  release: t.String(),
                  source: t.Union([SemanticSourceSchema, t.Null()]),
                }),
              ),
              next: t.Union([t.String(), t.Null()]),
            }),
            cacheControl,
          ),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.list_revisions',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, authorize, admission, job, session, set }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            listRevisions(pool, tokens, {
              subject: params.id,
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              authorize: check,
            }),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/graph',
      {
        response: { 400: problemSchema('invalid_request') },
        detail: {
          operationId: 'subject.graph_missing_anchor',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      () => {
        throw new ProblemError('invalid_request', { errors: [{ pointer: '/id', code: 'required' }] });
      },
    )
    .get(
      '/v1/subjects/:id/graph',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          property: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 8 }),
          direction: t.Union([t.Literal('out'), t.Literal('in'), t.Literal('both')]),
          depth: t.Numeric({ minimum: 1, maximum: 2, multipleOf: 1 }),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 25, multipleOf: 1, default: 12 })),
        }),
        response: {
          200: withHeaders(graphResponse, cacheControl),
          308: withHeaders(redirectResponse, { location: t.String() }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.graph',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, actor, authorize, admission, job, session, set, request }) => {
        const route = routeOf(params.id);
        if (route === null)
          throw new ProblemError('invalid_request', { errors: [{ pointer: '/id', code: 'invalid_format' }] });
        const properties = [...new Set(query.property)];
        if (properties.length !== query.property.length)
          throw new ProblemError('invalid_request', { errors: [{ pointer: '/property', code: 'invalid_format' }] });
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        for (const property of properties) {
          if (!Object.hasOwn(active.release.properties, property) || !isRelationProperty(active.release, property))
            throw new ProblemError('invalid_request', {
              errors: [{ pointer: '/property', code: 'unsupported' }],
            });
        }
        const resource = { route, id: params.id };
        const seen = [...session.components];
        await admission.run('normal', job, () => waitForSubjectLinks(pool, seen, params.id, job.deadline));
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            readStatementAs(pool, access(), actor, job.deadline, () =>
              listSubjectGraph(pool, tokens, {
                routeKey,
                subject: params.id,
                properties,
                direction: query.direction,
                depth: query.depth as 1 | 2,
                limit: query.limit ?? 12,
                languages: languageRanges(request.headers.get('accept-language')),
                release: active.release,
                authorizeSummary: summaryAuthorization(async (id, batch) => {
                  const route = routeOf(id)!;
                  return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
                }),
                authorize: check,
              }),
            ),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          return result;
        } catch (error) {
          if (error instanceof SubjectRedirectError) {
            set.status = 308;
            set.headers.location = `/v1/subjects/${error.to}/graph${new URL(request.url).search}`;
            return { redirect: { from: error.from, to: error.to } };
          }
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/counts',
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: withHeaders(SubjectCountsSchema, cacheControl),
          308: withHeaders(redirectResponse, { location: t.String() }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.counts',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job, session, set, request }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const resource = { route, id: params.id };
        const seen = [...session.components];
        await admission.run('normal', job, () => waitForSubjectLinks(pool, seen, params.id, job.deadline));
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component } = await admission.run('normal', job, () =>
            readSubjectRelationCounts(pool, { subject: params.id, release: active.release, authorize: check }),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          // Stored counters have no current source and target disclosure proof, so they remain internal.
          return { content: null };
        } catch (error) {
          if (error instanceof SubjectRedirectError) {
            set.status = 308;
            set.headers.location = `/v1/subjects/${error.to}/counts${new URL(request.url).search}`;
            return { redirect: { from: error.from, to: error.to } };
          }
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/links',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          context: t.Optional(EditorialBodyContext),
          ...pageQuery,
          property: t.Optional(t.String({ minLength: 1 })),
          filter: t.Optional(t.String({ format: 'uuid' })),
          type: t.Optional(t.String({ minLength: 1 })),
          language: t.Optional(t.String({ pattern: '^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$' })),
        }),
        response: {
          200: withHeaders(
            t.Object(
              {
                links: t.Array(
                  t.Object(
                    {
                      subject: t.String(),
                      property: t.String(),
                      statement: t.String(),
                      assertion: t.Optional(StatementSchema),
                      related: t.Optional(t.Record(t.String(), SubjectSummarySchema)),
                      type: t.String(),
                      label: t.String(),
                      summary: SubjectSummarySchema,
                    },
                    { additionalProperties: false },
                  ),
                ),
                count: t.Optional(t.Object({ value: t.Integer({ minimum: 0 }), exact: t.Boolean() })),
                freshness: t.Object(
                  {
                    consistency: t.Literal('eventual'),
                    target_seconds: t.Literal(10),
                    caught_up: t.Boolean(),
                  },
                  { additionalProperties: false },
                ),
                next: t.Union([t.String(), t.Null()]),
              },
              { additionalProperties: false },
            ),
            cacheControl,
          ),
          308: withHeaders(redirectResponse, { location: t.String() }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.links',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, actor, authorize, admission, job, session, set, request }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const active = await effectiveRelease(pool, query.context ?? GLOBAL_CONTEXT);
        if (!active) throw new ProblemError('semantic_not_ready');
        if (query.property !== undefined && !Object.hasOwn(active.release.properties, query.property))
          throw new ProblemError('invalid_request');
        if ((query.filter !== undefined || query.type !== undefined) && query.property === undefined)
          throw new ProblemError('invalid_request');
        if (query.filter !== undefined && !active.release.properties[query.property!]?.relation?.filter)
          throw new ProblemError('invalid_request');
        if (query.filter !== undefined && routeOf(query.filter) === null) throw new ProblemError('invalid_request');
        if (query.type !== undefined && !Object.hasOwn(active.release.types, query.type))
          throw new ProblemError('invalid_request');
        if (query.context !== undefined && routeOf(query.context) === null) throw new ProblemError('invalid_request');
        const resource = { route, id: params.id };
        const seen = [...session.components];
        const caughtUp = await admission.run('normal', job, () =>
          waitForSubjectLinks(pool, seen, params.id, job.deadline),
        );
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            readStatementAs(pool, access(), actor, job.deadline, () =>
              listSubjectLinks(pool, tokens, {
                routeKey,
                context: query.context ?? GLOBAL_CONTEXT,
                subject: params.id,
                property: query.property ?? null,
                limit: query.limit ?? 20,
                ...(query.filter === undefined ? {} : { filter: query.filter }),
                ...(query.type === undefined ? {} : { type: query.type }),
                languages: languageRanges(request.headers.get('accept-language'), query.language),
                release: active.release,
                includeLabels: true,
                authorizeSummary: summaryAuthorization(async (id, batch) => {
                  const route = routeOf(id)!;
                  return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
                }),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                authorize: check,
                seen,
                caughtUp,
              }),
            ),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          const links = result.links.flatMap(({ summary, ...link }) =>
            summary ? [{ ...link, type: summary.type, label: summary.label?.value ?? '', summary }] : [],
          );
          return { ...result, links };
        } catch (error) {
          if (error instanceof SubjectRedirectError) {
            set.status = 308;
            set.headers.location = `/v1/subjects/${error.to}/links${new URL(request.url).search}`;
            return { redirect: { from: error.from, to: error.to } };
          }
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/relations',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          ...pageQuery,
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 25 })),
          property: t.String({ minLength: 1 }),
          filter: t.Optional(t.String({ format: 'uuid' })),
          type: t.Optional(t.String({ minLength: 1 })),
          context: t.Optional(EditorialBodyContext),
          language: t.Optional(t.String({ pattern: '^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$' })),
        }),
        response: {
          200: withHeaders(
            t.Object(
              {
                relations: t.Array(
                  t.Object(
                    {
                      statement: StatementSchema,
                      related: t.Optional(t.Record(t.String(), SubjectSummarySchema)),
                      target: t.Union([t.String({ format: 'uuid' }), t.Null()]),
                      external: t.Union([t.String(), t.Null()]),
                      type: t.Optional(t.String()),
                      label: t.Optional(t.String()),
                      summary: t.Union([SubjectSummarySchema, t.Null()]),
                    },
                    { additionalProperties: false },
                  ),
                ),
                count: t.Optional(t.Object({ value: t.Integer({ minimum: 0 }), exact: t.Boolean() })),
                freshness: t.Object(
                  {
                    consistency: t.Literal('eventual'),
                    target_seconds: t.Literal(10),
                    caught_up: t.Boolean(),
                  },
                  { additionalProperties: false },
                ),
                next: t.Union([t.String(), t.Null()]),
              },
              { additionalProperties: false },
            ),
            cacheControl,
          ),
          308: withHeaders(redirectResponse, { location: t.String() }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.relations',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, actor, authorize, admission, job, session, set, request }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const active = await effectiveRelease(pool, query.context ?? GLOBAL_CONTEXT);
        if (!active) throw new ProblemError('semantic_not_ready');
        if (
          !Object.hasOwn(active.release.properties, query.property) ||
          !isRelationProperty(active.release, query.property)
        )
          throw new ProblemError('invalid_request');
        if (query.filter !== undefined && !active.release.properties[query.property]?.relation?.filter)
          throw new ProblemError('invalid_request');
        if (query.filter !== undefined && routeOf(query.filter) === null) throw new ProblemError('invalid_request');
        if (query.type !== undefined && !Object.hasOwn(active.release.types, query.type))
          throw new ProblemError('invalid_request');
        if (query.context !== undefined && routeOf(query.context) === null) throw new ProblemError('invalid_request');
        const resource = { route, id: params.id };
        const seen = [...session.components];
        const caughtUp = await admission.run('normal', job, () =>
          waitForSubjectLinks(pool, seen, params.id, job.deadline),
        );
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            readStatementAs(pool, access(), actor, job.deadline, () =>
              listSubjectRelations(pool, tokens, {
                routeKey,
                subject: params.id,
                property: query.property,
                ...(query.context === undefined ? {} : { context: query.context }),
                limit: query.limit ?? 25,
                ...(query.filter === undefined ? {} : { filter: query.filter }),
                ...(query.type === undefined ? {} : { type: query.type }),
                languages: languageRanges(request.headers.get('accept-language'), query.language),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                release: active.release,
                authorizeSummary: summaryAuthorization(async (id, batch) => {
                  const route = routeOf(id)!;
                  return authorize({ route, id, eligibility: relatedReadEligibility({ route, id }, batch) });
                }),
                authorize: check,
                seen,
                caughtUp,
              }),
            ),
          );
          session.record(component);
          set.headers['cache-control'] = 'no-cache';
          const relations = result.relations.map((relation) => ({
            ...relation,
            summary: relation.summary ?? null,
          }));
          return { ...result, relations };
        } catch (error) {
          if (error instanceof SubjectRedirectError) {
            set.status = 308;
            set.headers.location = `/v1/subjects/${error.to}/relations${new URL(request.url).search}`;
            return { redirect: { from: error.from, to: error.to } };
          }
          return candidateError(error);
        }
      },
    )
    .post(
      '/v1/statements/:id/disclose',
      {
        params: t.Object({ id: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        response: {
          200: withHeaders(t.Object({ candidate: t.String({ format: 'uuid' }), disclosed: t.Literal(true) }), {
            [SESSION_HEADER]: t.String(),
          }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'statement.disclose',
          'x-exposure': 'public',
          'x-action': 'statement:propose',
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'statement:propose',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(route),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            changeStatementDisclosure(pool, {
              routeKey,
              candidate: params.id,
              actor,
              authorization,
              deadline: job.deadline,
              clock,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('statement.disclose', actor, { candidate: params.id }),
            }),
          );
          session.record(result.component);
          return { candidate: result.candidate, disclosed: true as const };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      '/v1/statements/:id/retract',
      {
        params: t.Object({ id: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        response: {
          200: withHeaders(t.Object({ candidate: t.String({ format: 'uuid' }), retracted: t.Literal(true) }), {
            [SESSION_HEADER]: t.String(),
          }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'statement.retract',
          'x-exposure': 'public',
          'x-action': 'statement:propose',
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const authorization = await authorizeSemanticWrite({
          access: access(),
          actor,
          action: 'statement:propose',
          anchor: globalContextAnchor,
          pool,
          deadline: job.deadline,
          targetPartition: partitionOf(route),
          authorizeCommand,
          denied: () => new SubjectAccessDeniedError(),
        });
        try {
          const result = await admission.run('normal', job, () =>
            changeStatementDisclosure(pool, {
              routeKey,
              candidate: params.id,
              retract: true,
              actor,
              authorization,
              deadline: job.deadline,
              clock,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('statement.retract', actor, { candidate: params.id }),
            }),
          );
          session.record(result.component);
          return { candidate: result.candidate, retracted: true as const };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/reactions',
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: withHeaders(reactionCountResponse, cacheControl),
          308: withHeaders(redirectResponse, { location: t.String() }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.reactions',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job, set, request }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        const result = await admission.run('normal', job, () =>
          withConnection(pool, async (client) => {
            const subject = await readVisibility.run(client, { route, subject_id: params.id });
            if (!subject || subject.visibility !== 'visible' || !(await check(client)))
              throw new ProblemError('not_found');
            const redirect = await readRedirect.run(client, { route, subject_id: params.id });
            if (redirect?.target) return { redirect: redirect.target } as const;
            const result = await readReactionCounts(client, { targetId: params.id });
            return {
              counts: result.counts.map(({ kind, count }) => ({ kind, count })),
              watermark: result.watermark
                ? { epoch: result.watermark.epoch, position: result.watermark.position.toString() }
                : null,
            };
          }),
        );
        if ('redirect' in result) {
          set.status = 308;
          set.headers.location = `/v1/subjects/${result.redirect}/reactions${new URL(request.url).search}`;
          return { redirect: { from: params.id, to: result.redirect } };
        }
        set.headers['cache-control'] = 'no-cache';
        return result;
      },
    );
}

export { subjectRoutes };
