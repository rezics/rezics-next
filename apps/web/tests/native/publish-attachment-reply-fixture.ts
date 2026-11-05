import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import type { NativeWebStack } from './stack.ts';

type JsonObject = Record<string, unknown>;

async function call(
  stack: NativeWebStack,
  persona: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ response: Response; value: JsonObject }> {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') headers.set('idempotency-key', JSON.stringify(randomUUID()));
  const response = await stack.kernel(
    path,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    persona,
  );
  const text = await response.text();
  let value: JsonObject = {};
  if (text) {
    try {
      value = JSON.parse(text) as JsonObject;
    } catch {
      throw new Error(`Work-board fixture ${method} ${path} returned non-JSON (${response.status}): ${text}`);
    }
  }
  return { response, value };
}

async function requireOk<T extends JsonObject>(
  stack: NativeWebStack,
  persona: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await call(stack, persona, method, path, body);
  if (!result.response.ok)
    throw new Error(
      `Work-board fixture ${method} ${path} failed (${result.response.status}): ${JSON.stringify(result.value)}`,
    );
  return result.value as T;
}

export type PublishAttachmentWorkBoard = {
  boardId: string;
  boardTitle: string;
  conceptId: string;
  boardUrl: string;
  newThreadUrl: string;
};

/** Same Global discussion Board command seed:dev uses, with identities from the live native responses. */
export async function createPublishAttachmentWorkBoard(
  stack: NativeWebStack,
): Promise<PublishAttachmentWorkBoard> {
  const alice = await stack.authPersona('alice');
  const suffix = randomUUID().slice(0, 8);
  await requireOk(stack, 'governor', 'POST', '/v1/grants', {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: alice.accountId },
    actions: ['subject:create', 'board:create'],
    valid: '(,)',
  });
  const { subject } = await requireOk<{ subject: { id: string } }>(stack, 'alice', 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: `Work board concept ${suffix}` },
  });
  const boardTitle = `Work board discussion ${suffix}`;
  const { board } = await requireOk<{
    board: { id: string; realmId: string | null; purpose: string; visibility: string; availability: string };
  }>(stack, 'alice', 'POST', '/v1/boards', {
    conceptId: subject.id,
    title: boardTitle,
    purpose: 'discussion',
    visibility: 'published',
  });
  if (
    board.realmId !== null ||
    board.purpose !== 'discussion' ||
    board.visibility !== 'published' ||
    board.availability !== 'available'
  )
    throw new Error(`Work-board fixture did not admit a published Global discussion Board: ${JSON.stringify(board)}`);

  const query = new URLSearchParams({ purpose: 'discussion', limit: '100' });
  const directory = await call(stack, undefined, 'GET', `/v1/boards?${query}`);
  if (!directory.response.ok)
    throw new Error(
      `Anonymous board directory failed (${directory.response.status}): ${JSON.stringify(directory.value)}`,
    );
  const boards = Array.isArray(directory.value.boards) ? directory.value.boards : [];
  const admitted = boards.some((item) => {
    const row = item as JsonObject;
    return row.id === board.id && row.realmId === null && row.purpose === 'discussion' && row.visibility === 'published';
  });
  if (!admitted)
    throw new Error(`Anonymous directory did not admit Global board ${board.id}: ${JSON.stringify(directory.value)}`);

  return {
    boardId: board.id,
    boardTitle,
    conceptId: subject.id,
    boardUrl: `${stack.web}/en/boards/${board.id}`,
    newThreadUrl: `${stack.web}/en/boards/${board.id}/new`,
  };
}

export async function trustAccount(stack: NativeWebStack, accountId: string): Promise<void> {
  const key = randomUUID();
  await requireOk(stack, 'governor', 'POST', `/v1/accounts/${encodeURIComponent(accountId)}:setRateTier`, {
    key,
    tier: 'trusted',
  });
}
