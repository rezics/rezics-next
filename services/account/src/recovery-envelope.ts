import { createHmac, timingSafeEqual } from 'node:crypto';

export class RecoveryEnvelopeConflict extends Error {}

export interface RecoveryEnvelope {
  format: 'rezics-recovery-envelope-v1';
  kind: string;
  payload: string;
  mac: string;
}

function keyBytes(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new RecoveryEnvelopeConflict('recovery manifest key must be 32 bytes of hex');
  }
  return Buffer.from(hex, 'hex');
}

function mac(kind: string, payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('rezics-recovery-envelope-v1\0').update(kind).update('\0').update(payload)
    .digest();
}

/** Integrity only; retain the key and private envelope in separate protected custody. */
export function sealRecoveryPayload(payload: unknown, keyHex: string, kind: string): RecoveryEnvelope {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(kind)) {
    throw new RecoveryEnvelopeConflict('invalid recovery manifest kind');
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { format: 'rezics-recovery-envelope-v1', kind, payload: encoded,
    mac: mac(kind, encoded, keyBytes(keyHex)).toString('hex') };
}

export function openRecoveryPayload<T>(
  serialized: string, keyHex: string, expectedKind: string,
): T {
  let envelope: RecoveryEnvelope;
  try { envelope = JSON.parse(serialized) as RecoveryEnvelope; }
  catch { throw new RecoveryEnvelopeConflict('invalid recovery manifest envelope'); }
  if (envelope?.format !== 'rezics-recovery-envelope-v1'
    || envelope.kind !== expectedKind
    || !/^[A-Za-z0-9_-]+$/.test(envelope.payload ?? '')
    || !/^[0-9a-f]{64}$/.test(envelope.mac ?? '')) {
    throw new RecoveryEnvelopeConflict('invalid recovery manifest envelope');
  }
  const expected = mac(expectedKind, envelope.payload, keyBytes(keyHex));
  const provided = Buffer.from(envelope.mac, 'hex');
  if (!timingSafeEqual(expected, provided)) {
    throw new RecoveryEnvelopeConflict('recovery manifest authentication failed');
  }
  try { return JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8')) as T; }
  catch { throw new RecoveryEnvelopeConflict('invalid recovery manifest payload'); }
}
