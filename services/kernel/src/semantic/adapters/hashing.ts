import { createHash } from 'node:crypto';
import { memoizedValue } from '../../memoized.ts';
import type { HashPort } from '../contract/domain-ports.ts';

/** Native SHA-256 hex digest. Composition binds this; cores never import crypto. */
export function nativeHashing(): HashPort {
  return memoizedValue(nativeHashing, () =>
    Object.freeze({
      sha256Hex(canonical: string) {
        return createHash('sha256').update(canonical).digest('hex');
      },
    }),
  );
}
