import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { preparedPrivateReaderOrigin, type PrivateReaderOrigin } from './private-reader-origin';
import type { ResolvedReportTarget as ModerationTarget } from './reports-read';
import { appealReadKey, type AppealReadInput, type PrivateAppealPage } from './appeals-read-model';
import { isPlatformClosedError } from '../kernel/platform-closed';

export const MODERATION_APPEALS_PAGE_SIZE = 20;
export type AppealAppellantIdentity =
  | {
      state: 'available';
      kind: 'actor' | 'organization';
      handle: string | null;
      displayName: string | null;
      automated: boolean;
    }
  | { state: 'deleted' }
  | { state: 'concealed' }
  | { state: 'unavailable' };
export type AppealTargetContext =
  | {
      state: 'available';
      destination: { kind: 'board'; id: string } | { kind: 'thread'; id: string; boardId: string };
    }
  | { state: 'concealed' }
  | { state: 'unavailable' };
export type AppealResolutionSnapshot = {
  outcome: 'upheld' | 'reversed';
  statement: string;
  resolvedAt: string;
};
export type AppealSource = { partition: number; epoch: number; position: string };
export type AppealProvenance = {
  actorId: string;
  session: { clientId: string; authnEpoch: number };
  source: AppealSource;
};
export type AppealResolutionCommand = {
  operationId: 'moderation_appeal.resolve';
  method: 'POST';
  path: string;
};
export type Appeal = {
  id: string;
  decisionId: string;
  appellantId: string;
  appellantIdentity?: AppealAppellantIdentity;
  statement: string;
  createdAt: string;
  targetContext?: AppealTargetContext;
  resolution?: AppealResolutionSnapshot | null;
  resolutionCommand?: AppealResolutionCommand;
  source?: AppealSource;
  decision: {
    statement: string;
    target?: { kind: 'board' | 'post' | 'thread'; id: string };
    targetKind?: 'board' | 'post' | 'thread';
    targetId?: string;
    /** Retained for existing component fixtures; native lists expose only canResolve. */
    deciderId?: string;
    appeal?: { outcome: 'reversed' | 'upheld'; statement: string; resolvedAt: string } | null;
  };
  canResolve?: boolean;
};
/** Consumer presentation, independent of the pending page. Native binding remains unavailable. */
export type AppealPage = {
  appeals: Appeal[];
  next: string | null;
  selectedAppeal?: Appeal;
  provenance?: AppealProvenance;
};
export type AppealReadSource = {
  boardAppeals: (id: string, cursor?: string, inspect?: string) => Promise<AppealPage>;
  threadAppeals: (id: string, cursor?: string, inspect?: string) => Promise<AppealPage>;
};
export type AppealTargetReads = {
  post: (id: string) => Promise<ModerationTarget['value']>;
  thread: (id: string) => Promise<ModerationTarget['value']>;
};

/** Use the installed declaration, including every field its producer supplies. */
type NativeAppealPage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['boards']>['appeals']['get']>>['data']>;

function boundedAppealPage(page: NativeAppealPage | null | undefined): AppealPage {
  if (!page || !Array.isArray(page.appeals) || page.appeals.length > MODERATION_APPEALS_PAGE_SIZE)
    throw new Error('Invalid appeals page');
  return page;
}

/** One bounded native page; optional context belongs to its native producer. */
export async function readModerationAppeals(source: AppealReadSource, input: AppealReadInput): Promise<AppealPage> {
  return input.threadId
    ? source.threadAppeals(input.threadId, input.cursor, input.inspect)
    : source.boardAppeals(input.boardId, input.cursor, input.inspect);
}

export async function resolveAppealTargets(appeals: Appeal[], reads: AppealTargetReads): Promise<ModerationTarget[]> {
  const unique = new Map<string, NonNullable<Appeal['decision']['target']>>();
  for (const appeal of appeals) {
    const target = appealTarget(appeal);
    if (target && target.kind !== 'board') unique.set(`${target.kind}:${target.id}`, target);
  }
  return Promise.all(
    [...unique].map(async ([key, target]) => ({
      key,
      kind: target.kind,
      value: target.kind === 'board' ? null : await reads[target.kind](target.id).catch(() => null),
    })),
  );
}

export function appealTarget(appeal: Appeal): Appeal['decision']['target'] {
  return (
    appeal.decision.target ??
    (appeal.decision.targetKind && appeal.decision.targetId
      ? { kind: appeal.decision.targetKind, id: appeal.decision.targetId }
      : undefined)
  );
}

const auth = (authorization: string) => ({ headers: { authorization }, fetch: { cache: 'no-store' as const } });

export const loadModerationAppeals = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw notFound();
    const value = input as Record<string, unknown>;
    if (typeof value.boardId !== 'string' || value.boardId.length > 128) throw notFound();
    if (value.threadId !== undefined && (typeof value.threadId !== 'string' || value.threadId.length > 128))
      throw notFound();
    if (value.postId !== undefined && (typeof value.postId !== 'string' || value.postId.length > 128)) throw notFound();
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096))
      throw notFound();
    if (
      value.inspect !== undefined &&
      (typeof value.inspect !== 'string' || value.inspect.length === 0 || value.inspect.length > 128)
    )
      throw notFound();
    return {
      boardId: value.boardId,
      ...(typeof value.inspect === 'string' ? { inspect: value.inspect } : {}),
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
      ...(typeof value.postId === 'string' ? { postId: value.postId } : {}),
      ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }): Promise<PrivateAppealPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadModerationAppealsRequest(getRequest(), env as Partial<SessionEnv>, data);
  });

export async function loadModerationAppealsRequest(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: AppealReadInput,
  client: () => KernelClient = kernelClient,
): Promise<PrivateAppealPage> {
  const identity = {
    readKey: appealReadKey(data),
    viewerId: null,
    readerOrigin: null,
    generation: crypto.randomUUID(),
  };
  try {
    await prepareSession(request, sessionEnv);
  } catch {
    return { ...identity, appeals: [], targets: [], next: null, state: 'unavailable' };
  }
  const authorization = viewerCredential(request);
  const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
  if (!authorization || !readerOrigin) return { ...identity, appeals: [], targets: [], next: null, state: 'closed' };
  return readModerationAppealPage(client(), data, authorization, readerOrigin.subject, readerOrigin);
}

class AppealReadFailure extends Error {
  constructor(readonly state: 'closed' | 'unavailable' | 'stale') {
    super(state);
  }
}
function appealResult(result: {
  data?: NativeAppealPage | null;
  error?: { status: number; value: unknown } | null;
}): AppealPage {
  if (result.error) {
    const { status, value } = result.error;
    if (
      value &&
      typeof value === 'object' &&
      'code' in value &&
      ((status === 400 && value.code === 'invalid_cursor') || (status === 409 && value.code === 'stale_cursor'))
    )
      throw new AppealReadFailure('stale');
    throw new AppealReadFailure([401, 403, 404].includes(status) ? 'closed' : 'unavailable');
  }
  return boundedAppealPage(result.data);
}

/**
 * The installed client declares only pending pages. Exact inspection must not silently
 * degrade into page search or an undeclared request. Bind the generated inspect reader
 * here when Content installs its composed response and examples.
 */
export async function readModerationAppealPage(
  client: KernelClient,
  input: AppealReadInput,
  authorization: string,
  viewerId: string,
  readerOrigin?: PrivateReaderOrigin | null,
): Promise<PrivateAppealPage> {
  const identity = {
    readKey: appealReadKey(input),
    viewerId,
    readerOrigin: readerOrigin ?? null,
    generation: crypto.randomUUID(),
  };
  if (input.inspect)
    return {
      ...identity,
      appeals: [],
      targets: [],
      next: null,
      state: 'unavailable',
      unavailableReason: 'native-appeal-inspect',
    };
  try {
    const headers = auth(authorization);
    const page = await readModerationAppeals(
      {
        boardAppeals: async (id, cursor) =>
          appealResult(
            await client.boards({ id }).appeals.get({
              ...headers,
              query: { limit: MODERATION_APPEALS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            }),
          ),
        threadAppeals: async (id, cursor) =>
          appealResult(
            await client.threads({ id }).appeals.get({
              ...headers,
              query: { limit: MODERATION_APPEALS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            }),
          ),
      },
      input,
    );
    return { ...page, targets: [], ...identity, state: 'ready' };
  } catch (error) {
    return {
      ...identity,
      appeals: [],
      targets: [],
      next: null,
      state: error instanceof AppealReadFailure ? error.state : isPlatformClosedError(error) ? 'closed' : 'unavailable',
    };
  }
}
