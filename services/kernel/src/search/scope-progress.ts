import { FILTER_LIMITS } from '@rezics/filter';

export type ScopeLeafPosition = Readonly<{
  leafOrdinal: number;
  phase: 'compact' | 'selection' | 'witness';
  valueOrdinal: number;
  after: string | null;
}> | null;

/** Counts in current deterministic leaf order; each entry counts that leaf's admitted values. */
export type ScopeLeafLimits = Readonly<{ valueCounts: readonly number[] }>;
export type ScopeLeafProgressResult = { ok: true; position: ScopeLeafPosition } | { ok: false; reason: 'invalid' };

function validateLimits(limits: ScopeLeafLimits): void {
  if (!limits || !Array.isArray(limits.valueCounts) || limits.valueCounts.length > FILTER_LIMITS.leaves)
    throw new TypeError('Invalid current leaf limits');
  for (const count of limits.valueCounts)
    if (!Number.isInteger(count) || count < 1 || count > FILTER_LIMITS.in)
      throw new TypeError('Invalid current value count');
}

function validateOrdinals(position: NonNullable<ScopeLeafPosition>, limits: ScopeLeafLimits): void {
  const { leafOrdinal, valueOrdinal } = position;
  if (
    !Number.isInteger(leafOrdinal) ||
    leafOrdinal < 0 ||
    leafOrdinal >= limits.valueCounts.length ||
    !Number.isInteger(valueOrdinal) ||
    valueOrdinal < 0 ||
    valueOrdinal >= limits.valueCounts[leafOrdinal]!
  )
    throw new TypeError('Invalid current leaf position');
}

/** Raw progress only: the existing list cursor owns encryption, binding and lifetime. */
export function packScopeLeafProgress(position: ScopeLeafPosition, limits: ScopeLeafLimits): string {
  validateLimits(limits);
  if (position === null) return '';
  if (typeof position !== 'object' || Array.isArray(position)) throw new TypeError('Invalid leaf position');
  validateOrdinals(position, limits);
  const { phase, after } = position;
  if (after !== null && typeof after !== 'string') throw new TypeError('Invalid leaf after');
  const bytes = Buffer.alloc(18);
  bytes[0] = (1 << 5) | position.leafOrdinal;
  let wirePhase: number;
  if (phase === 'compact' || phase === 'selection') {
    wirePhase = phase === 'compact' ? 0 : 1;
    if (after !== null) {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(after)) throw new TypeError('Invalid sequence');
      const sequence = BigInt(after);
      if (sequence > (1n << 64n) - 2n) throw new TypeError('Sequence overflow');
      bytes.writeBigUInt64BE(sequence + 1n, 2);
    }
  } else if (phase === 'witness') {
    wirePhase = after === null ? 3 : 2;
    if (after !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(after))
        throw new TypeError('Invalid witness UUID');
      Buffer.from(after.replaceAll('-', ''), 'hex').copy(bytes, 2);
    }
  } else throw new TypeError('Invalid leaf phase');
  bytes[1] = (wirePhase << 6) | position.valueOrdinal;
  return bytes.toString('base64url');
}

/** Structural validation is not an actor, group, query or native-basis authorization check. */
export function unpackScopeLeafProgress(record: unknown, limits: ScopeLeafLimits): ScopeLeafProgressResult {
  try {
    validateLimits(limits);
    if (record === '') return { ok: true, position: null };
    if (typeof record !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(record)) return { ok: false, reason: 'invalid' };
    const bytes = Buffer.from(record, 'base64url');
    if (bytes.length !== 18 || bytes.toString('base64url') !== record || bytes[0]! >>> 5 !== 1)
      return { ok: false, reason: 'invalid' };
    const wirePhase = bytes[1]! >>> 6;
    let after: string | null = null;
    if (wirePhase < 2) {
      if (bytes.subarray(10).some((byte) => byte !== 0)) return { ok: false, reason: 'invalid' };
      const sequence = bytes.readBigUInt64BE(2);
      after = sequence === 0n ? null : (sequence - 1n).toString();
    } else if (wirePhase === 2) {
      const hex = bytes.subarray(2).toString('hex');
      after = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } else if (bytes.subarray(2).some((byte) => byte !== 0)) return { ok: false, reason: 'invalid' };
    const position: NonNullable<ScopeLeafPosition> = {
      leafOrdinal: bytes[0]! & 31,
      phase: wirePhase === 0 ? 'compact' : wirePhase === 1 ? 'selection' : 'witness',
      valueOrdinal: bytes[1]! & 63,
      after,
    };
    validateOrdinals(position, limits);
    return { ok: true, position };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
