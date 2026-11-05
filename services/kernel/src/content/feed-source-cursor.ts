import { canonicalParameters, type CursorBinding, type CursorResult } from '../tokens/cursor.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';

const scope = (binding: CursorBinding) =>
  `content.feed.source.v1\0${binding.operation}\0${canonicalParameters(binding.parameters)}`;
/** Internal durable work positions use native sealing without an HTTP session lifetime. A queued
 * continuation may outlive fifteen minutes. No allow, body or identity decision is carried here;
 * current source epochs, retention and final owner admission are checked on every use. */
export function encodeCursor(
  tokens: KeyRing,
  binding: CursorBinding,
  value: { epoch: number; after: readonly (string | number)[] },
  _now?: number,
): string {
  return seal(tokens, scope(binding), value);
}
export function decodeCursor(tokens: KeyRing, binding: CursorBinding, token: string, _now?: number): CursorResult {
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  const value = unseal(tokens, scope(binding), token) as { epoch?: unknown; after?: unknown } | null;
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'after,epoch' ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Array.isArray(value.after) ||
    value.after.length > 8 ||
    value.after.some((entry) => typeof entry !== 'string' || Buffer.byteLength(entry) > 512)
  )
    return { ok: false, reason: 'invalid' };
  return { ok: true, epoch: value.epoch as number, after: value.after };
}
