import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import type { CommandPrincipal } from './command.ts';

const VARIABLE = 'KERNEL_RECEIPT_KEYS';
const rings = new WeakMap<object, KeyRing>();
const configuredPools = new WeakSet<Pool>();

function assertDedicatedKeys(ring: KeyRing, sealingKeys: Iterable<Uint8Array>): void {
  const sealing = [...sealingKeys].map((key) => Buffer.from(key));
  if ([...ring.keys.values()].some((key) => sealing.some((other) => Buffer.from(key).equals(other))))
    throw new Error(`${VARIABLE} must not reuse a token sealing key`);
}

/** Receipt keys are permanent: retire a version only after re-keying all its receipts. */
export function assertReceiptKeyRing(ring: KeyRing, sealing?: KeyRing): void {
  if (ring.keys.size < 1 || ring.keys.size > 4) throw new Error(`${VARIABLE} must retain between 1 and 4 versions`);
  if (!ring.keys.has(ring.current)) throw new Error(`${VARIABLE} current version must exist`);
  for (const [version, key] of ring.keys) {
    if (!Number.isInteger(version) || version < 0 || version > 255 || key.byteLength < 32)
      throw new Error(`${VARIABLE} versions must be 0..255 with at least 32 key bytes`);
  }
  if (sealing) assertDedicatedKeys(ring, sealing.keys.values());
}

/** Required trusted configuration, shared by HTTP, workers and native consumers. */
export function readReceiptKeyRing(env: NodeJS.ProcessEnv = process.env, configured?: KeyRing): KeyRing {
  const ring = configured ?? parseReceiptKeyRing(env);
  if (!ring) throw new Error(`${VARIABLE} is required`);
  assertReceiptKeyRing(ring);
  // Workers do not consume the sealing ring, but must still reject shared key material.
  const sealingKeys = (env.KERNEL_SESSION_KEYS?.split(',') ?? []).map((entry) =>
    Buffer.from(entry.split(':')[1] ?? '', 'base64url'),
  );
  assertDedicatedKeys(ring, sealingKeys);
  return ring;
}

function parseReceiptKeyRing(env: NodeJS.ProcessEnv): KeyRing | undefined {
  const value = env[VARIABLE];
  if (value === undefined) return undefined;
  const keys = new Map<number, Uint8Array>();
  for (const entry of value.split(',')) {
    const match = /^(0|[1-9]\d*):([A-Za-z0-9_-]+)$/.exec(entry);
    const version = Number(match?.[1]);
    const encoded = match?.[2];
    if (!Number.isInteger(version) || encoded === undefined || keys.has(version))
      throw new Error(`${VARIABLE} must contain distinct version:base64url entries`);
    const key = Buffer.from(encoded, 'base64url');
    if (key.toString('base64url') !== encoded) throw new Error(`${VARIABLE} keys must be canonical base64url`);
    keys.set(version, key);
  }
  return { current: keys.keys().next().value!, keys };
}

/** Bind trusted service configuration to the pool used by every command consumer. */
export function configureReceiptKeys(pool: Pool, ring: KeyRing): void {
  assertReceiptKeyRing(ring);
  const prior = rings.get(pool);
  if (
    prior &&
    [...prior.keys].some(([v, key]) => !ring.keys.has(v) || !Buffer.from(key).equals(Buffer.from(ring.keys.get(v)!)))
  )
    throw new Error(`${VARIABLE} must retain existing versions and key material until receipts are re-keyed`);
  rings.set(pool, {
    current: ring.current,
    keys: new Map([...ring.keys].map(([v, key]) => [v, Uint8Array.from(key)])),
  });
  if (!configuredPools.has(pool)) {
    configuredPools.add(pool);
    // Every checkout, including existing idle connections, inherits current trusted configuration.
    pool.on('acquire', (client) => rings.set(client, rings.get(pool)!));
  }
}

export function receiptKeysFor(source: object): KeyRing {
  // Access deadline wrappers inherit their underlying client; transaction wrappers are explicitly bound.
  for (let current: object | null = source; current; current = Object.getPrototypeOf(current)) {
    const ring = rings.get(current);
    if (ring) return ring;
  }
  return readReceiptKeyRing();
}

export function bindReceiptKeys(target: object, ring: KeyRing): void {
  rings.set(target, ring);
}

/** Native readers use the same framed tuple as the command executor. Null provenance finds no receipt. */
export function nativeReceiptKeyCandidates(
  source: object,
  kind: string | null,
  accountId: string,
  raw: string | null,
): string[] {
  if (kind === null || raw === null) return [];
  return receiptKeyCandidates(receiptKeysFor(source), kind, { kind: 'account', id: accountId }, raw);
}

function tokenAt(ring: KeyRing, version: number, kind: string, principal: CommandPrincipal, raw: string): string {
  // JSON tuple framing prevents delimiter collisions; UUID identity follows PostgreSQL's canonical spelling.
  const body = JSON.stringify([version, kind, principal.kind, principal.id.toLowerCase(), raw]);
  const mac = createHmac('sha256', ring.keys.get(version)!)
    .update('rezics.receipt-key.v1\0')
    .update(body, 'utf8')
    .digest('base64url');
  return `rk1.${version}.${mac}`;
}

/** Only the ring version and keyed digest are public, never the caller's text. */
export function encodeReceiptKey(ring: KeyRing, kind: string, principal: CommandPrincipal, raw: string): string {
  assertReceiptKeyRing(ring);
  return tokenAt(ring, ring.current, kind, principal, raw);
}

/** One HMAC per retained version; sorted versions followed by the transitional raw key, deduplicated. */
export function receiptKeyCandidates(ring: KeyRing, kind: string, principal: CommandPrincipal, raw: string): string[] {
  assertReceiptKeyRing(ring);
  return [
    ...new Set(
      [...ring.keys.keys()]
        .sort((a, b) => a - b)
        .map((v) => tokenAt(ring, v, kind, principal, raw))
        .concat(raw),
    ),
  ];
}
