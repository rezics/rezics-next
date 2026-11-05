import { seal, unseal, type KeyRing } from './seal.ts';

export type CursorBinding = {
  operation: string;
  parameters: Readonly<Record<string, string | number | boolean | null>>;
};

export type CursorKey = string | number;

export type CursorResult =
  | { ok: true; epoch: number; after: CursorKey[] }
  | { ok: false; reason: 'expired' | 'invalid' };

type CursorInput = { epoch: number; after: readonly CursorKey[] };

export function canonicalParameters(parameters: CursorBinding['parameters']): string {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
    throw new TypeError('Cursor parameters must be an object');
  const entries: string[] = [];
  for (const key of Object.keys(parameters).sort()) {
    const value = parameters[key];
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new TypeError('Invalid cursor parameter');
    entries.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${entries.join(',')}}`;
}

function cursorScope(binding: CursorBinding): string {
  if (binding === null || typeof binding !== 'object' || typeof binding.operation !== 'string')
    throw new TypeError('Invalid cursor binding');
  return `cursor\0${binding.operation}\0${canonicalParameters(binding.parameters)}`;
}

function validAfter(after: unknown): after is CursorKey[] {
  return (
    Array.isArray(after) &&
    after.length <= 8 &&
    after.every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
  );
}

function validateInput(input: CursorInput, now: number): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || !validAfter(input.after))
    throw new TypeError('Invalid cursor');
}

export function encodeCursor(ring: KeyRing, binding: CursorBinding, cursor: CursorInput, now = Date.now()): string {
  const scope = cursorScope(binding);
  validateInput(cursor, now);
  return seal(ring, scope, { e: cursor.epoch, a: cursor.after, t: now });
}

export function decodeCursor(ring: KeyRing, binding: CursorBinding, token: string, now = Date.now()): CursorResult {
  let scope: string;
  try {
    scope = cursorScope(binding);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!Number.isSafeInteger(now)) return { ok: false, reason: 'invalid' };

  const payload = unseal(ring, scope, token);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return { ok: false, reason: 'invalid' };
  const value = payload as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.e) ||
    (value.e as number) < 1 ||
    !validAfter(value.a) ||
    !Number.isSafeInteger(value.t)
  )
    return { ok: false, reason: 'invalid' };

  const issuedAt = value.t as number;
  if (issuedAt - now > 60_000) return { ok: false, reason: 'invalid' };
  if (now - issuedAt > 15 * 60_000) return { ok: false, reason: 'expired' };
  return { ok: true, epoch: value.e as number, after: value.a };
}
