import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { GoResolutionInvalid, type GoModuleRequirement,
  validateGoModuleRequirement } from './go-mvs.ts';
import { parseGoModRequirements, type ParsedGoMod } from './go-mod-parser.ts';

export class GoProxyCaptureInvalid extends Error {}
export class GoProxyCaptureConflict extends Error {}
export class GoProxyCaptureMissing extends Error {}
export class GoProxyCaptureUnavailable extends Error {}

export interface GoProxyCaptureRequest extends GoModuleRequirement {
  profile: 'go-module-proxy-capture-v1';
}

interface CapturedBytes {
  list: Buffer;
  info: Buffer;
  mod: Buffer;
  fetchedAt: Date;
}

export interface GoProxyCaptureResult {
  profile: 'go-module-proxy-capture-v1';
  capture: string;
  provider: 'proxy.golang.org';
  path: string;
  version: string;
  requestDigest: string;
  fetchedAt: string;
  versionList: { url: string; rawSha256: string; byteLength: number;
    stableVersions: string[]; omittedTagCount: number };
  info: { url: string; rawSha256: string; byteLength: number; time: string };
  manifest: { url: string; rawSha256: string; byteLength: number; text: string;
    parsed: ParsedGoMod };
  createdAt: string;
}

interface Row {
  id: string; principal_id: string; idempotency_key: string;
  request_digest: string; capture_digest: string;
  module_path: string; module_version: string;
  list_bytes: Buffer; info_bytes: Buffer; mod_bytes: Buffer;
  fetched_at: Date; created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const STABLE = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const ORIGIN = 'https://proxy.golang.org';

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requestDigest(input: GoProxyCaptureRequest): string {
  return sha(Buffer.from(`${input.path}\0${input.version}`));
}

function captureDigest(bytes: CapturedBytes): string {
  const hash = createHash('sha256');
  for (const part of [bytes.list, bytes.info, bytes.mod]) {
    hash.update(`${part.byteLength}:`).update(part);
  }
  return hash.digest('hex');
}

function checkedRequest(input: GoProxyCaptureRequest): void {
  if (input.profile !== 'go-module-proxy-capture-v1') {
    throw new GoProxyCaptureInvalid('invalid Go proxy capture profile');
  }
  try { validateGoModuleRequirement(input); }
  catch (error) {
    if (error instanceof GoResolutionInvalid) {
      throw new GoProxyCaptureInvalid(error.message);
    }
    throw error;
  }
}

function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new GoProxyCaptureUnavailable('Go proxy response is not UTF-8'); }
}

function parseList(bytes: Buffer, requested: string):
  { stableVersions: string[]; omittedTagCount: number } {
  const value = decode(bytes);
  const versions = value.split('\n').filter(Boolean);
  if (versions.length > 2048 || new Set(versions).size !== versions.length
    || versions.some(version => !/^v[0-9][0-9A-Za-z.+-]{0,100}$/.test(version))) {
    throw new GoProxyCaptureUnavailable('Go proxy version list is invalid');
  }
  const stableVersions = versions.filter(version => STABLE.test(version));
  if (!stableVersions.includes(requested)) {
    throw new GoProxyCaptureUnavailable('requested stable tag is absent from Go proxy list');
  }
  return { stableVersions, omittedTagCount: versions.length - stableVersions.length };
}

function parseInfo(bytes: Buffer, requested: string): string {
  let value: unknown;
  try { value = JSON.parse(decode(bytes)); }
  catch { throw new GoProxyCaptureUnavailable('Go proxy version info is invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoProxyCaptureUnavailable('Go proxy version info is invalid');
  }
  const info = value as { Version?: unknown; Time?: unknown };
  if (info.Version !== requested || typeof info.Time !== 'string'
    || !Number.isFinite(Date.parse(info.Time))) {
    throw new GoProxyCaptureUnavailable('Go proxy version info does not match request');
  }
  return info.Time;
}

async function bounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new GoProxyCaptureUnavailable('Go proxy response has no body');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared)
    || Number(declared) > maxBytes)) {
    throw new GoProxyCaptureUnavailable('Go proxy response exceeds byte limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new GoProxyCaptureUnavailable('Go proxy response exceeds byte limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoProxyCaptureUnavailable) throw error;
    throw new GoProxyCaptureUnavailable('Go proxy response was interrupted');
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) {
    throw new GoProxyCaptureUnavailable('Go proxy response length is incomplete');
  }
  return Buffer.concat(chunks, size);
}

/** Fixed-origin, bounded module metadata fetch. A capture is an observation, not an atomic proxy cut. */
export async function fetchGoProxyCapture(input: GoProxyCaptureRequest,
  fetcher: typeof fetch = fetch): Promise<CapturedBytes> {
  checkedRequest(input);
  const paths = [`/${input.path}/@v/list`, `/${input.path}/@v/${input.version}.info`,
    `/${input.path}/@v/${input.version}.mod`];
  const limits = [131072, 4096, 131072];
  const parts: Buffer[] = [];
  for (let index = 0; index < paths.length; index++) {
    let response: Response;
    try {
      response = await fetcher(`${ORIGIN}${paths[index]}`, { method: 'GET',
        redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: {
          accept: 'application/octet-stream',
          'user-agent': 'REZICS-go-module-capture/1 (bounded metadata lookup)',
        } });
    } catch { throw new GoProxyCaptureUnavailable('Go proxy request failed'); }
    if (response.status === 404) throw new GoProxyCaptureMissing('Go module metadata was not found');
    if (response.status !== 200) {
      throw new GoProxyCaptureUnavailable('Go proxy response is unavailable');
    }
    parts.push(await bounded(response, limits[index]!));
  }
  const list = parts[0]!;
  const info = parts[1]!;
  const mod = parts[2]!;
  parseList(list, input.version);
  parseInfo(info, input.version);
  if (!mod.length) throw new GoProxyCaptureUnavailable('Go module manifest is empty');
  decode(mod);
  return { list, info, mod, fetchedAt: new Date() };
}

export class GoProxyCaptureStore {
  constructor(private readonly pool: Pool, private readonly fetcher: typeof fetch = fetch) {}

  private verified(row: Row): GoProxyCaptureResult {
    const request: GoProxyCaptureRequest = { profile: 'go-module-proxy-capture-v1',
      path: row.module_path, version: row.module_version };
    checkedRequest(request);
    const bytes = { list: row.list_bytes, info: row.info_bytes,
      mod: row.mod_bytes, fetchedAt: row.fetched_at };
    if (row.request_digest !== requestDigest(request)
      || row.capture_digest !== captureDigest(bytes)) {
      throw new GoProxyCaptureUnavailable('stored Go proxy capture digest differs');
    }
    const versionList = parseList(bytes.list, request.version);
    const time = parseInfo(bytes.info, request.version);
    return { profile: request.profile, capture: `https://rezics.com/id/${row.id}`,
      provider: 'proxy.golang.org', path: request.path, version: request.version,
      requestDigest: row.request_digest, fetchedAt: row.fetched_at.toISOString(),
      versionList: { url: `${ORIGIN}/${request.path}/@v/list`,
        rawSha256: sha(bytes.list), byteLength: bytes.list.length, ...versionList },
      info: { url: `${ORIGIN}/${request.path}/@v/${request.version}.info`,
        rawSha256: sha(bytes.info), byteLength: bytes.info.length, time },
      manifest: { url: `${ORIGIN}/${request.path}/@v/${request.version}.mod`,
        rawSha256: sha(bytes.mod), byteLength: bytes.mod.length, text: decode(bytes.mod),
        parsed: parseGoModRequirements(decode(bytes.mod), request.path) },
      createdAt: row.created_at.toISOString() };
  }

  async capture(principalId: string, key: string, input: GoProxyCaptureRequest):
    Promise<{ capture: GoProxyCaptureResult; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) {
      throw new GoProxyCaptureInvalid('invalid Go capture identity or idempotency key');
    }
    checkedRequest(input);
    const digest = requestDigest(input);
    const prior = (await this.pool.query<Row>(`SELECT * FROM pkg.go_proxy_capture
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (prior) {
      if (prior.request_digest !== digest) {
        throw new GoProxyCaptureConflict('Go capture key binds another request');
      }
      return { capture: this.verified(prior), replayed: true };
    }
    const bytes = await fetchGoProxyCapture(input, this.fetcher);
    const inserted = await this.pool.query(`INSERT INTO pkg.go_proxy_capture
      (id, principal_id, idempotency_key, request_digest, capture_digest,
       module_path, module_version, list_bytes, info_bytes, mod_bytes, fetched_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, digest, captureDigest(bytes),
      input.path, input.version, bytes.list, bytes.info, bytes.mod, bytes.fetchedAt]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.go_proxy_capture
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== digest) {
      throw new GoProxyCaptureConflict('Go capture key binds another request');
    }
    return { capture: this.verified(row), replayed: inserted.rowCount === 0 };
  }

  async read(principalId: string, captureId: string): Promise<GoProxyCaptureResult | null> {
    if (!UUID.test(principalId) || !UUID.test(captureId)) {
      throw new GoProxyCaptureInvalid('invalid Go capture identity');
    }
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.go_proxy_capture
      WHERE id = $1 AND principal_id = $2`, [captureId, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
