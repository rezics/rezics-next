import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { ANONYMOUS_PRINCIPAL_ID, normalizeCommandKey } from './key.ts';
import type { Actor } from '../request/access.ts';
import { anchorRoute, derivedId } from '../route/route.ts';

export function requestDigest(operation: string, actor: Actor, body: unknown): Uint8Array {
  const canonical = canonicalize({
    operation,
    client_id: actor.kind === 'anonymous' ? null : actor.clientId,
    requested_by: actor.kind === 'anonymous' ? null : actor.requestedBy,
    body,
  });
  if (canonical === undefined) throw new TypeError('Request body must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Stable tuple home under the server-owned route key; grants no authorization. */
export function anonymousCommandTarget(
  routeKey: Uint8Array,
  operation: string,
  key: string,
): { route: number; id: string } {
  const name = JSON.stringify([
    'anonymous',
    ANONYMOUS_PRINCIPAL_ID,
    operation,
    normalizeCommandKey({ kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID }, key),
  ]);
  const route = anchorRoute(routeKey, name);
  return { route, id: derivedId(ANONYMOUS_PRINCIPAL_ID, name, route) };
}

/** The caller owns all normalized effect fields in semantic; fresh proof is excluded. */
export function anonymousRequestDigest(operation: string, input: { semantic: unknown; abuse?: unknown }): Uint8Array {
  return requestDigest(operation, { kind: 'anonymous' }, input.semantic);
}
