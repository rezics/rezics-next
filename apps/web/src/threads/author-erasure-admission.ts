import type { KernelClient } from '@rezics/client';
import type { ErasureIdentity } from './author-erasure';

export type AuthorErasureAdmission =
  | { kind: 'current'; mayErase: boolean; authorId?: string }
  | { kind: 'unavailable' | 'signed-out' | 'forbidden' | 'not-found' };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Producer-owned GET /v1/threads/{id} envelope. No ownership/edit/delete inference. */
export function parseAuthorErasureAdmission(
  value: unknown,
  threadId: string,
  authorId: string,
): AuthorErasureAdmission {
  if (!record(value) || !record(value.thread) || value.thread.id !== threadId) return { kind: 'unavailable' };
  const field = value.authorErasure;
  if (
    !record(field) ||
    Object.keys(field).length !== 2 ||
    field.authorId !== authorId ||
    typeof field.mayErase !== 'boolean'
  )
    return { kind: 'unavailable' };
  return { kind: 'current', authorId, mayErase: field.mayErase };
}

/** One explicit current read via the existing generated method and server session. */
export async function currentAuthorErasureAdmission(
  client: KernelClient,
  identity: ErasureIdentity,
  threadId: string,
): Promise<AuthorErasureAdmission> {
  try {
    const result = await client.threads({ id: threadId }).get({
      headers: { authorization: identity.authorization, 'cache-control': 'no-store' },
    });
    if (result.error || result.status !== 200)
      return {
        kind:
          result.status === 401
            ? 'signed-out'
            : result.status === 403
              ? 'forbidden'
              : result.status === 404
                ? 'not-found'
                : 'unavailable',
      };
    const response: unknown = result.data;
    return parseAuthorErasureAdmission(response, threadId, identity.subject);
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Presentation lifetime only; uncertain command intent is held separately by the entry. */
export function authorErasureAdmissionReads() {
  let scope = '';
  let version = 0;
  let value: AuthorErasureAdmission = { kind: 'unavailable' };
  return {
    bind(threadId: string, authorId: string | null, open: boolean, sessionRevision = 0) {
      const next = JSON.stringify([threadId, authorId, open, sessionRevision]);
      if (next !== scope) {
        scope = next;
        version++;
        value = { kind: 'unavailable' };
      }
      return value;
    },
    retire() {
      version++;
      scope = '';
      value = { kind: 'unavailable' };
    },
    async refresh(
      authorId: string,
      read: () => Promise<AuthorErasureAdmission>,
      isCurrent: () => boolean = () => true,
    ) {
      const ticket = ++version;
      const originalScope = scope;
      value = { kind: 'unavailable' };
      let result: AuthorErasureAdmission;
      try {
        result = await read();
      } catch {
        result = { kind: 'unavailable' };
      }
      if (ticket !== version || originalScope !== scope || !isCurrent()) return false;
      value = result.kind === 'current' && result.authorId !== authorId ? { kind: 'unavailable' } : result;
      return true;
    },
  };
}
