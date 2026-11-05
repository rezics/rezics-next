import { securityResponseLimits } from '@rezics/auth-contract';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export class SecurityInventoryDenied extends Error {
  constructor(readonly status = 400) {
    super('Security inventory denied');
  }
}

export type SecurityPageInput = { cursor?: string; limit?: number };
export type SecurityView = 'clients' | 'consents';
export type SecurityCursorBinding = {
  accountId: string;
  sessionId: string;
  clientId: string;
  epoch: number;
  scopes: readonly string[];
};

export function securityPageInput(
  input: SecurityPageInput,
): Required<Pick<SecurityPageInput, 'limit'>> & SecurityPageInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'cursor' && key !== 'limit') ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' ||
        input.cursor.length > securityResponseLimits.cursor ||
        !/^[A-Za-z0-9_-]{40,}$/.test(input.cursor))) ||
    (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
  )
    throw new SecurityInventoryDenied();
  return { ...input, limit: input.limit ?? 20 };
}

export function securityPageQuery(query: URLSearchParams): SecurityPageInput {
  for (const key of query.keys()) {
    if (!['cursor', 'limit'].includes(key) || query.getAll(key).length !== 1) throw new SecurityInventoryDenied();
  }
  const limit = query.get('limit');
  if (limit !== null && !/^(?:[1-9][0-9]?|100)$/.test(limit)) throw new SecurityInventoryDenied();
  return securityPageInput({
    ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
    ...(limit === null ? {} : { limit: Number(limit) }),
  });
}

/** The persistent Auth secret, using the same HKDF/AES-GCM primitives as native
 * credential staging. No cursor keys or inventory copies are persisted. */
export function securityCursors(secret: string, issuer: string, now: () => number) {
  function context(view: SecurityView, binding: SecurityCursorBinding, limit: number) {
    return {
      key: Buffer.from(hkdfSync('sha256', secret, '', `rezics.auth.security-inventory.${view}.v1`, 32)),
      aad: Buffer.from(JSON.stringify([1, issuer, view, binding, limit])),
    };
  }
  return {
    read(cursor: string | undefined, view: SecurityView, binding: SecurityCursorBinding, limit: number): string | null {
      if (cursor === undefined) return null;
      const time = now();
      try {
        const bytes = Buffer.from(cursor, 'base64url');
        if (bytes.toString('base64url') !== cursor) throw new Error('Noncanonical cursor');
        const { key, aad } = context(view, binding, limit);
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value: unknown = JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
        );
        if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid cursor');
        const [after, expires] = value;
        if (
          typeof after !== 'string' ||
          !after ||
          after.length > 1024 ||
          after.includes('\u0000') ||
          !Number.isSafeInteger(expires) ||
          expires <= time ||
          expires > time + 900
        )
          throw new Error('Expired cursor');
        return after;
      } catch {
        throw new SecurityInventoryDenied();
      }
    },
    write(after: string, view: SecurityView, binding: SecurityCursorBinding, limit: number): string {
      if (!after || after.length > 1024 || after.includes('\u0000')) throw new SecurityInventoryDenied(503);
      const { key, aad } = context(view, binding, limit);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const bytes = Buffer.concat([cipher.update(JSON.stringify([after, now() + 900])), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
    },
  };
}
