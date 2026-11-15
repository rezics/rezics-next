import { createHash } from 'node:crypto';
import { ProblemError } from '../http/problem-error.ts';
import type { AccessCheck, AccessClient, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_SUBJECT_CONTEXT } from '../semantic/contract/subject-values.ts';
import { globalReadEligibility, subjectReadEligibility } from '../semantic/eligibility.ts';
import {
  IDENTITY_SUBJECT_SCOPE_MAX_ORIGINALS,
  readIdentitySubjectScope,
  readIdentitySubjectScopePage,
  type IdentitySubjectScope,
  type IdentitySubjectScopeFrontier,
} from '../semantic/identity-subject-scope.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import { accessCheck } from './access-port.ts';
import {
  KnowledgeInvalidCursorError,
  KnowledgeNotFoundError,
  KnowledgeStaleCursorError,
  type KnowledgeDependencies,
} from './knowledge-model.ts';
import { knowledgeOwnedSubjectNotebookPage } from './knowledge-store.ts';
import { snapshot } from './reads.ts';

type NotebookKey = Readonly<{ createdAt: string; notebookId: string }>;
type NotebookContinuation = Readonly<{
  basis: string;
  frontier: IdentitySubjectScopeFrontier | null;
  within: (NotebookKey & { pageBasis: string }) | null;
}>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDigest = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);

function readContinuation(keys: readonly CursorKey[], route: number): NotebookContinuation {
  const [basis, after, seen, pageBasis, createdAt, notebookId] = keys;
  if (
    (keys.length !== 3 && keys.length !== 6) ||
    !isDigest(basis) ||
    typeof after !== 'string' ||
    typeof seen !== 'number' ||
    !Number.isSafeInteger(seen) ||
    (after === '' ? seen !== 0 : routeOf(after) === null || seen < 1 || seen >= IDENTITY_SUBJECT_SCOPE_MAX_ORIGINALS)
  )
    throw new KnowledgeInvalidCursorError();
  const frontier = after ? { after, seen } : null;
  if (keys.length === 3) {
    if (frontier === null) throw new KnowledgeInvalidCursorError();
    return { basis, frontier, within: null };
  }
  if (
    !isDigest(pageBasis) ||
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof notebookId !== 'string' ||
    routeOf(notebookId) !== route
  )
    throw new KnowledgeInvalidCursorError();
  return { basis, frontier, within: { pageBasis, createdAt, notebookId } };
}

function continuationKeys(continuation: NotebookContinuation): CursorKey[] {
  const { basis, frontier, within } = continuation;
  return [
    basis,
    frontier?.after ?? '',
    frontier?.seen ?? 0,
    ...(within ? [within.pageBasis, within.createdAt, within.notebookId] : []),
  ];
}

export async function readKnowledgeOwnedSubjectNotebookPage(
  deps: KnowledgeDependencies,
  actor: AccountActor,
  deadline: number,
  request: Readonly<{ subjectId: string; limit: number; cursor?: string }>,
) {
  const { accountId, clientId, requestedBy, authnEpoch, scopes } = actor;
  const { subjectId, limit } = request;
  const route = routeOf(accountId);
  if (route === null || routeOf(subjectId) === null) throw new KnowledgeNotFoundError();
  const binding: CursorBinding = {
    operation: 'GET /v1/accounts/:accountId/knowledge/notebooks',
    parameters: {
      accountId,
      clientId,
      requestedBy,
      authnEpoch,
      scopes: digest([...scopes].sort()),
      route,
      subjectId,
      limit,
    },
  };
  const token =
    request.cursor === undefined ? null : decodeCursor(deps.tokens, binding, request.cursor, deps.clock().getTime());
  if (token && !token.ok) throw new KnowledgeInvalidCursorError();
  const continuation = token?.ok ? readContinuation(token.after, route) : null;
  const context = { actor, deadline };
  const accessContext = { pool: deps.pool, deadline };
  const ownerCheck = await accessCheck(deps.access, actor, 'account:read', { route, id: accountId }, accessContext);
  const globalCheck = await accessCheck(
    deps.access,
    actor,
    'subject:read',
    { route: 0, id: GLOBAL_SUBJECT_CONTEXT, eligibility: globalReadEligibility('subject:read') },
    accessContext,
  );
  const prepareSubject = (id: string) => {
    const resource = { route: routeOf(id)!, id };
    return accessCheck(
      deps.access,
      actor,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      accessContext,
    );
  };
  const requestedCheck = await prepareSubject(subjectId);
  const withheld = (): never => {
    if (continuation) throw new KnowledgeStaleCursorError();
    throw new KnowledgeNotFoundError();
  };
  const scopeChanged = (): never => {
    if (continuation) throw new KnowledgeStaleCursorError();
    throw new ProblemError('dependency_unavailable');
  };
  const readScope = async (client: AccessClient) => {
    if (!(await ownerCheck(client))) throw new KnowledgeNotFoundError();
    if (!(await globalCheck(client)) || !(await requestedCheck(client))) withheld();
    const scope = await readIdentitySubjectScope(client, subjectId);
    if (scope.state === 'missing') withheld();
    if (scope.state !== 'ready') throw new ProblemError('dependency_unavailable');
    if (continuation && scope.basis !== continuation.basis) throw new KnowledgeStaleCursorError();
    return scope;
  };
  const readPage = async (client: AccessClient, scope: IdentitySubjectScope) => {
    const page = await readIdentitySubjectScopePage(client, subjectId, scope, continuation?.frontier ?? null);
    if (page.state !== 'ready') throw new ProblemError('dependency_unavailable');
    return page;
  };
  const proposed = await snapshot(deps, accountId, context, async (client) => {
    const scope = await readScope(client);
    // The requested Subject already passed Access. A distinct terminal needs its own
    // preparation after this connection has been released and before reading its members.
    return { scope, page: scope.terminal === subjectId ? await readPage(client, scope) : null };
  });
  if (token?.ok && token.epoch !== proposed.anchor.epoch) throw new KnowledgeStaleCursorError();
  const terminal = proposed.value.scope.terminal;
  const terminalCheck = terminal === subjectId ? requestedCheck : await prepareSubject(terminal);
  const confirmScope = async (client: AccessClient) => {
    const scope = await readScope(client);
    if (scope.basis !== proposed.value.scope.basis) scopeChanged();
    if (terminal !== subjectId && !(await terminalCheck(client))) withheld();
    return scope;
  };
  const proposedPage =
    proposed.value.page ??
    (await snapshot(deps, accountId, context, async (client) => readPage(client, await confirmScope(client)))).value;
  const checks = new Map<string, AccessCheck>();
  for (const id of proposedPage.visibleOriginals) {
    if (id !== terminal && id !== subjectId) checks.set(id, await prepareSubject(id));
  }

  const result = await snapshot(deps, accountId, context, async (client) => {
    const scope = await confirmScope(client);
    const window = await readPage(client, scope);
    if (window.pageBasis !== proposedPage.pageBasis) scopeChanged();
    const originals: string[] = [];
    for (const id of window.visibleOriginals) {
      if (id === terminal || id === subjectId || (await checks.get(id)!(client))) originals.push(id);
    }
    const pageBasis = digest([window.pageBasis, originals]);
    const within = continuation?.within ?? null;
    if (within && within.pageBasis !== pageBasis) throw new KnowledgeStaleCursorError();
    const rows = await knowledgeOwnedSubjectNotebookPage(client, route, accountId, originals, within, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next =
      last && rows.length > limit
        ? {
            basis: scope.basis,
            frontier: continuation?.frontier ?? null,
            within: { pageBasis, createdAt: last.created_at_key, notebookId: last.notebook_id },
          }
        : window.next && { basis: scope.basis, frontier: window.next, within: null };
    return { rows: page, next };
  });
  if (result.anchor.epoch !== proposed.anchor.epoch) scopeChanged();
  const next = result.value.next
    ? encodeCursor(
        deps.tokens,
        binding,
        { epoch: result.anchor.epoch, after: continuationKeys(result.value.next) },
        deps.clock().getTime(),
      )
    : null;
  return { rows: result.value.rows, next, anchor: result.anchor };
}
