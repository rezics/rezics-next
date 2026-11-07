import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import {
  membershipProperties,
  readSourceConcept,
  validConceptCursor,
  validMembershipCursor,
  type ConceptMembershipCursors,
  type ConceptRead,
} from './index';

const exploreId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isExploreId(value: string): boolean {
  return exploreId.test(value);
}

/** Session and kernel client come from web-app public entries; graph-browser is not this reader's surface. */
async function exploreContext(locale: string, expectedReader: string | null) {
  const { env } = await import('cloudflare:workers');
  const { prepareSession, sessionSubject, viewerCredential } = await import('../../../session/request');
  const { kernelClient } = await import('../../../kernel/client');
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as import('../../../session/client').SessionEnv);
  const reader = sessionSubject(request);
  const authorization = viewerCredential(request) ?? undefined;
  if (expectedReader === null ? !!reader || !!authorization : reader !== expectedReader || !authorization) return null;
  return { client: kernelClient(locale), authorization };
}

export const readSubjectConcept = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid concept address');
    const input = value as Record<string, unknown>;
    if (
      typeof input.id !== 'string' ||
      !isExploreId(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35
    )
      throw new Error('Invalid concept address');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !validConceptCursor(input.cursor)))
      throw new Error('Invalid concept continuation');
    const membership = membershipCursors(input.membership);
    return {
      expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
      id: input.id,
      locale: input.locale,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      ...(membership ? { membership } : {}),
      role: typeof input.role === 'string' && input.role.length <= 128 ? input.role : undefined,
      session: typeof input.session === 'string' && input.session.length <= 16384 ? input.session : undefined,
    };
  })
  .handler(async ({ data }): Promise<ConceptRead> => {
    const prepared = await exploreContext(data.locale, data.expectedReader);
    if (!prepared) return { ok: false, reason: 'denied' };
    const { fetchGuideRelease } = await import('../definition-guide');
    const headers = prepared.authorization ? { authorization: prepared.authorization } : {};
    let release;
    try {
      release = await fetchGuideRelease(prepared.client, undefined, headers);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    return readSourceConcept(prepared.client, prepared.authorization, release, data.id, data.locale, data);
  });

function membershipCursors(value: unknown): ConceptMembershipCursors | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid membership continuation');
  const input = value as Record<string, unknown>;
  const cursors: ConceptMembershipCursors = {};
  for (const property of membershipProperties) {
    const cursor = input[property];
    if (cursor === undefined) continue;
    if (typeof cursor !== 'string' || !validMembershipCursor(cursor))
      throw new Error('Invalid membership continuation');
    cursors[property] = cursor;
  }
  if (Object.keys(input).some((key) => !membershipProperties.includes(key as (typeof membershipProperties)[number])))
    throw new Error('Invalid membership continuation');
  return Object.keys(cursors).length ? cursors : undefined;
}
