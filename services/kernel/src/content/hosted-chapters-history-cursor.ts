import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ReadContext } from './model.ts';
import { InvalidHostedCursorError, type HostedDependencies } from './hosted-chapters-model.ts';
import type { HostedHistoryCursor } from './hosted-chapters-history-model.ts';

export function hostedHistoryBinding(catalogueId: string, context: ReadContext, limit: number): CursorBinding {
  const actor = context.actor;
  if (actor.kind !== 'account') throw new InvalidHostedCursorError();
  return {
    operation: 'content.hosted-catalogue.history',
    parameters: {
      catalogueId,
      limit,
      accountId: actor.accountId,
      clientId: actor.clientId,
      requestedBy: actor.requestedBy,
      authnEpoch: actor.authnEpoch,
      scopes: [...actor.scopes].sort().join(' '),
    },
  };
}

function cipherKey(ring: KeyRing, kid: number): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new InvalidHostedCursorError();
  return createHmac('sha256', key).update('content.hosted-catalogue.history.encryption.v1').digest();
}

/** Encrypt the revision boundary in addition to the ordinary scoped token seal. */
export function writeHostedHistoryCursor(
  deps: Pick<HostedDependencies, 'tokens' | 'clock'>,
  binding: CursorBinding,
  state: HostedHistoryCursor,
): string {
  const kid = deps.tokens.current;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(deps.tokens, kid), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(state.after), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  // The original issuance time is retained across every continuation. The token
  // seal and explicit issuance check both use the same non-renewable lifetime.
  return encodeCursor(
    deps.tokens,
    binding,
    { epoch: state.epoch, after: [kid, payload, state.issuedAt] },
    state.issuedAt,
  );
}

export function readHostedHistoryCursor(
  deps: Pick<HostedDependencies, 'tokens' | 'clock'>,
  binding: CursorBinding,
  catalogueId: string,
  epoch: number,
  token: string | undefined,
): HostedHistoryCursor | null {
  if (token === undefined) return null;
  try {
    const now = deps.clock().getTime();
    const decoded = decodeCursor(deps.tokens, binding, token, now);
    if (!decoded.ok || decoded.epoch !== epoch || decoded.after.length !== 3) throw new InvalidHostedCursorError();
    const [kid, payload, issuedAt] = decoded.after;
    if (
      typeof kid !== 'number' ||
      typeof payload !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      typeof issuedAt !== 'number' ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > now + 60_000 ||
      now - issuedAt > 15 * 60_000
    )
      throw new InvalidHostedCursorError();
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== payload) throw new InvalidHostedCursorError();
    const cipher = createDecipheriv('aes-256-gcm', cipherKey(deps.tokens, kid), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const key: unknown = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
    if (
      !key ||
      typeof key !== 'object' ||
      !('createdAt' in key) ||
      typeof key.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(key.createdAt) ||
      !Number.isFinite(Date.parse(key.createdAt)) ||
      !('revisionId' in key) ||
      typeof key.revisionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key.revisionId) ||
      routeOf(key.revisionId) !== routeOf(catalogueId)
    )
      throw new InvalidHostedCursorError();
    return { after: { createdAt: key.createdAt, revisionId: key.revisionId }, epoch, issuedAt };
  } catch {
    // Only token decoding is collapsed: native authorization and database errors
    // must keep their original failure rather than becoming invalid cursors.
    throw new InvalidHostedCursorError();
  }
}
