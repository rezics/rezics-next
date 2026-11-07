import type { NativePublicOutputApplication } from '../contract/native-public-output.ts';

/** Bind a fully constructed Library adapter as one immutable application capability. */
export function createNativePublicOutputApplication<Tx, PoolLike, Time>(
  operations: NativePublicOutputApplication<Tx, PoolLike, Time>,
): NativePublicOutputApplication<Tx, PoolLike, Time> {
  return Object.freeze({ ...operations });
}
