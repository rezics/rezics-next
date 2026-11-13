import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import { memoizedValue } from '../memoized.ts';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { customMethod, defineRateLimit } from '../http/route-metadata.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { contentRequestId } from './adapters/bind.ts';
import type { hostedDraftConversionRoutes } from './hosted-draft-conversion-routes.ts';
import { strictContentSchema } from './schema-validation.ts';
import {
  ContentNotFoundError as CommandNotFoundError,
  ContentForbiddenError,
  RevisionPreconditionError,
} from './commands.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  issueRevisionDisclosure,
  readRevisionDisclosure,
  revokeRevisionDisclosure,
  type RevisionDisclosureCommandValue,
  type RevisionDisclosureDependencies,
  type RevisionDisclosureIssueInput,
  type RevisionDisclosureTarget,
} from './revision-disclosure.ts';
import {
  RevisionDisclosureIssueSchema,
  RevisionDisclosureReceiptSchema,
  RevisionDisclosureRevokeSchema,
} from './revision-disclosure-schemas.ts';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };

function params() {
  return memoizedValue(params, () => t.Object({ id: HostedIdSchema }, { additionalProperties: false }));
}

function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    412: problemSchema('precondition_failed'),
    413: problemSchema('content_too_large'),
    422: problemSchema('idempotency_conflict', 'too_many_events'),
    429: problemSchema('rate_limited'),
    500: problemSchema('internal_error'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
      'rate_limit_unavailable',
    ),
  }));
}

function writeDetail(operationId: string) {
  return {
    'x-exposure': 'public',
    'x-resource-types': ['content.post'],
    'x-action': 'post:revise',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }],
    operationId,
  };
}

function sameSource(left: RevisionDisclosureTarget, right: RevisionDisclosureTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

/** Path UUID is a locator. It never substitutes for the exact source tuple. */
function bindSourcePost(postId: string, target: RevisionDisclosureTarget): RevisionDisclosureTarget {
  if (target.postId !== postId) throw new CommandNotFoundError();
  return target;
}

function receipt(value: RevisionDisclosureCommandValue): RevisionDisclosureCommandValue {
  return {
    disclosureId: value.disclosureId,
    state: value.state,
    catalogueId: value.catalogueId,
    reused: value.reused,
    ...(value.durableInitiator === undefined ? {} : { durableInitiator: value.durableInitiator }),
  };
}

function commandContext(request: Request, deadline: number) {
  return {
    deadline,
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    requestId: contentRequestId(),
  };
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof CommandNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    throw error;
  }
}

function accountActor(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}

function boundIssue(postId: string, body: RevisionDisclosureIssueInput): RevisionDisclosureIssueInput {
  return {
    catalogueId: body.catalogueId,
    target: bindSourcePost(postId, body.target),
  };
}

async function boundRevoke(
  dependencies: RevisionDisclosureDependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  postId: string,
  body: Readonly<{ disclosureId: string; catalogueId: string; target: RevisionDisclosureTarget }>,
  deadline: number,
) {
  const target = bindSourcePost(postId, body.target);
  const observation = await readRevisionDisclosure(dependencies, body.disclosureId, { actor, deadline });
  if (observation.catalogue.catalogueId !== body.catalogueId || !sameSource(observation.target, target))
    throw new CommandNotFoundError();
  return { disclosureId: observation.disclosureId };
}

/** Mount issue and revoke on the source Post. Catalogue routes do not admit these commands. */
export function revisionDisclosureRoutes(
  app: ReturnType<typeof hostedDraftConversionRoutes>,
  dependencies: RevisionDisclosureDependencies,
) {
  return app
    .post(
      customMethod('/v1/posts/:id', 'issueRevisionDisclosure'),
      {
        params: params(),
        headers,
        body: strictContentSchema(RevisionDisclosureIssueSchema),
        response: {
          200: withHeaders(strictContentSchema(RevisionDisclosureReceiptSchema), responseHeaders),
          ...failures(),
        },
        detail: writeDetail('post.issue_revision_disclosure'),
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        const issuer = accountActor(actor);
        const context = commandContext(request, job.deadline);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            issueRevisionDisclosure(dependencies, issuer, boundIssue(id, body), context),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return receipt(result.value);
      },
    )
    .post(
      customMethod('/v1/posts/:id', 'revokeRevisionDisclosure'),
      {
        params: params(),
        headers,
        body: strictContentSchema(RevisionDisclosureRevokeSchema),
        response: {
          200: withHeaders(strictContentSchema(RevisionDisclosureReceiptSchema), responseHeaders),
          ...failures(),
        },
        detail: writeDetail('post.revoke_revision_disclosure'),
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        const revoker = accountActor(actor);
        const context = commandContext(request, job.deadline);
        const result = await operation(() =>
          admission.run('normal', job, async () => {
            const input = await boundRevoke(dependencies, revoker, id, body, context.deadline);
            return revokeRevisionDisclosure(dependencies, revoker, input, context);
          }),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return receipt(result.value);
      },
    );
}
