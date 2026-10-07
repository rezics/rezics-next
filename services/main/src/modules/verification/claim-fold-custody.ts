import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { hash, type WorkActivationEnvironment } from '../work/activate.ts';

export const CLAIM_FOLD_CUSTODY_COST = { bytes: 16_384, depth: 16 } as const;
export class ClaimFoldCustodyUnavailable extends Error {}
export interface ClaimFoldCustodyBytes {
  manifest: string;
  payload: string;
  state: Record<string, unknown>;
}

const unavailable = (): never => {
  throw new ClaimFoldCustodyUnavailable('Exact Claim fold custody bytes are unavailable');
};

/** Strict bounded JSON inspection leaves the original byte spelling untouched. */
function inspect(bytes: Buffer): { text: string; value: Record<string, unknown> } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return unavailable();
  }
  let at = 0;
  const whitespace = () => {
    while (at < text.length && /[\t\r\n ]/u.test(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return unavailable();
        }
      }
    }
    return unavailable();
  };
  const value = (depth: number): void => {
    if (depth > CLAIM_FOLD_CUSTODY_COST.depth) unavailable();
    whitespace();
    const char = text[at];
    if (char === '"') {
      string();
      return;
    }
    if (char === '{' || char === '[') {
      at++;
      const end = char === '{' ? '}' : ']';
      const keys = new Set<string>();
      whitespace();
      if (text[at] === end) {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        if (char === '{') {
          if (text[at] !== '"') unavailable();
          const key = string();
          if (keys.has(key)) unavailable();
          keys.add(key);
          whitespace();
          if (text[at++] !== ':') unavailable();
        }
        value(depth + 1);
        whitespace();
        if (text[at] === end) {
          at++;
          return;
        }
        if (text[at++] !== ',') unavailable();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(at),
    );
    if (!token) return unavailable();
    at += token[0].length;
  };
  value(0);
  whitespace();
  if (at !== text.length) unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unavailable();
  return { text, value: parsed as Record<string, unknown> };
}

export function assertClaimFoldCustodyText(text: string): void {
  if (
    typeof text !== 'string' ||
    text.length > CLAIM_FOLD_CUSTODY_COST.bytes ||
    Buffer.byteLength(text, 'utf8') > CLAIM_FOLD_CUSTODY_COST.bytes
  )
    unavailable();
  inspect(Buffer.from(text, 'utf8'));
}

async function objectBytes(env: WorkActivationEnvironment, digest: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/u.test(digest)) unavailable();
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(30_000);
  if (signal.aborted) unavailable();
  let bytes: Buffer | undefined;
  if (env.workObjects)
    try {
      bytes = Buffer.from(await env.workObjects.get(digest, CLAIM_FOLD_CUSTODY_COST.bytes, signal));
    } catch (error) {
      // Only absence permits the established legacy-directory fallback, never corruption or a budget refusal.
      if (!(error instanceof ObjectUnavailable)) throw error;
    }
  if (bytes === undefined) {
    let fd: number | undefined;
    try {
      fd = openSync(join(env.objectDirectory, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > CLAIM_FOLD_CUSTODY_COST.bytes) unavailable();
      const bounded = Buffer.alloc(CLAIM_FOLD_CUSTODY_COST.bytes + 1);
      let size = 0;
      for (;;) {
        const read = readSync(fd, bounded, size, bounded.length - size, null);
        if (!read) break;
        size += read;
        if (size > CLAIM_FOLD_CUSTODY_COST.bytes) unavailable();
      }
      bytes = bounded.subarray(0, size);
    } catch {
      return unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (signal.aborted || bytes.length > CLAIM_FOLD_CUSTODY_COST.bytes || hash(bytes) !== digest)
    unavailable();
  return bytes;
}

/** Return original owner bytes only after digest, descriptor, component and profile verification. */
export async function readClaimFoldCustody(
  env: WorkActivationEnvironment,
  manifestIri: string,
  component: string,
  profile: string,
): Promise<ClaimFoldCustodyBytes> {
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/u.test(manifestIri)) unavailable();
  const manifest = inspect(await objectBytes(env, manifestIri.slice(-64)));
  const row = manifest.value;
  if (
    Object.keys(row).sort().join(',') !==
      'component,format,mediaType,model,payload,payloadBytes,shape' ||
    row.format !== 'rezics-manifest-v1' ||
    row.component !== component ||
    row.model !== profile ||
    row.shape !== profile ||
    row.mediaType !== 'application/json' ||
    typeof row.payload !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.payload) ||
    !Number.isSafeInteger(row.payloadBytes) ||
    Number(row.payloadBytes) < 1 ||
    Number(row.payloadBytes) > CLAIM_FOLD_CUSTODY_COST.bytes
  )
    unavailable();
  const payloadBytes = await objectBytes(env, (row.payload as string).slice(7));
  if (payloadBytes.length !== row.payloadBytes) unavailable();
  const payload = inspect(payloadBytes);
  if (
    Object.keys(payload.value).sort().join(',') !== 'component,format,state' ||
    payload.value.format !== 'rezics-component-v1' ||
    payload.value.component !== component ||
    !payload.value.state ||
    typeof payload.value.state !== 'object' ||
    Array.isArray(payload.value.state)
  )
    unavailable();
  return {
    manifest: manifest.text,
    payload: payload.text,
    state: payload.value.state as Record<string, unknown>,
  };
}
