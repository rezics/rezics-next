import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, AccountActor } from '../request/access.ts';

export type RequestContext = Readonly<{ deadline: number }>;
export type CommandRequestContext = RequestContext &
  Readonly<{
    idempotencyKey: string;
    requestId: string;
  }>;

export type AuthorErasureInput = Readonly<{
  threadId: string;
  authorId: string;
}>;

/** Counts are bounded to non-negative integers no greater than Number.MAX_SAFE_INTEGER. */
export type OperationCount = number;

export type OperationMetadata = Readonly<{
  type: 'content.author_erasure';
  threadId: string;
  authorId: string;
  processedPosts: OperationCount;
  erasedRevisions: OperationCount;
}>;

export type OperationResponse = Readonly<{
  processedPosts: OperationCount;
  erasedRevisions: OperationCount;
}>;

export type OperationProgress = Readonly<{
  processedPosts: OperationCount;
  erasedRevisions: OperationCount;
}>;

export type Problem = Readonly<{
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}>;

type OperationBase = Readonly<{
  name: `operations/${string}`;
  metadata: OperationMetadata;
}>;

/** A bounded AIP-151 view. Terminal operations expose exactly one result arm. */
export type Operation =
  | (OperationBase & Readonly<{ done: false; response?: never; error?: never }>)
  | (OperationBase & Readonly<{ done: true; response: OperationResponse; error?: never }>)
  | (OperationBase & Readonly<{ done: true; error: Problem; response?: never }>);

export type NativeWorkflowStatus = Readonly<{
  done: boolean;
  /** Bounded progress from native workflow events or its durable checkpoint. */
  progress: OperationProgress;
  response?: OperationResponse;
  error?: Problem;
}>;

/** Adapter around native DBOS enqueue/status APIs; it owns no workflow state.
 * Enqueue receives only a verified initiating account snapshot. Workflow steps
 * must revalidate current Access state for each affected post.
 */
export interface NativeAuthorErasureWorkflows {
  enqueue(
    input: Readonly<{
      operationId: string;
      threadId: string;
      authorId: string;
      actor: AccountActor;
    }>,
    context: CommandRequestContext,
  ): Promise<void>;
  status(operationId: string, context: RequestContext): Promise<NativeWorkflowStatus | null>;
}

export interface AuthorErasureDependencies {
  pool: Pool;
  access: Access;
  /** Trusted server clock, never supplied by the request or workflow payload. */
  clock: () => Date;
  workflows: NativeAuthorErasureWorkflows;
}

export type BeginAuthorErasure = (
  deps: AuthorErasureDependencies,
  actor: import('../request/access.ts').Actor,
  input: AuthorErasureInput,
  context: CommandRequestContext,
) => Promise<CommandOutcome<{ operationId: string }>>;

export type ReadOperation = (
  deps: AuthorErasureDependencies,
  actor: import('../request/access.ts').Actor,
  operationId: string,
  context: RequestContext,
) => Promise<Operation | null>;

/** Operation reads must use account:read at the actor's account anchor and
 * conceal anonymous actors and initiator mismatches with the same not-found.
 * The actual self-read grant belongs to Accounts' Access integration.
 */
