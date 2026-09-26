import { createHash } from 'node:crypto';
import { npmSha, npmStable } from './npm-lock.ts';
import { NPM_REGISTRY_ORIGIN, npmRegistryLimits, npmRegistryPackumentUrl, npmRegistryTarballAllowed,
  projectNpmPackument, retainNpmCandidates, solveNpmRegistry, type NpmRegistryArtifact,
  type NpmRegistryOutcome, type NpmRegistryPackument, type NpmRegistryRequest, type NpmRegistrySnapshot,
  type NpmRegistrySource } from './npm-registry.ts';

export class NpmRegistryCancelled extends Error {}
export interface NpmRegistryCaptureOptions {
  fetcher?: typeof fetch; now?: () => number; signal?: AbortSignal;
  /** Receives exact provider bytes; used only by the live oracle to serve npm the same snapshot. */
  observe?: (url: string, bytes: Uint8Array) => void;
}
const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8';
const REQUEST_TIMEOUT_MS = 15_000;

async function bounded(response: Response, limit: number, hash?: ReturnType<typeof createHash>):
  Promise<{ bytes: Uint8Array | null; length: number; exceeded: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) { await response.body?.cancel(); return { bytes: null, length: declared, exceeded: true }; }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); return { bytes: null, length, exceeded: true }; }
      if (hash) hash.update(value); else chunks.push(value);
    }
  }
  return { bytes: hash ? null : Buffer.concat(chunks), length, exceeded: false };
}

/** Lazily captures abbreviated packuments from the fixed public registry origin. */
export class NpmRegistryCapture implements NpmRegistrySource {
  readonly captured = new Map<string, NpmRegistryPackument>();
  private bytes = 0;
  private readonly deadline: number;
  constructor(private readonly options: NpmRegistryCaptureOptions = {}) {
    this.deadline = this.now() + npmRegistryLimits.deadlineMs;
  }
  now(): number { return this.options.now ? this.options.now() : Date.now(); }
  get exceededAt(): string | null {
    return [...this.captured.values()].find(item => item.reason === 'capture deadline')?.name ?? null;
  }
  checkCancelled(): void {
    if (this.options.signal?.aborted) throw new NpmRegistryCancelled('npm registry capture was cancelled');
  }
  async packument(name: string): Promise<NpmRegistryPackument> {
    this.checkCancelled();
    const url = npmRegistryPackumentUrl(name);
    const failed = (status: NpmRegistryPackument['status'], reason: string, httpStatus: number | null = null,
      byteLength: number | null = null): NpmRegistryPackument => ({ name, url, status, reason, httpStatus,
      sha256: null, byteLength, versionCount: 0, distTags: {}, records: [] });
    let result: NpmRegistryPackument;
    if (this.now() > this.deadline) result = failed('budget-exhausted', 'capture deadline');
    else {
      try {
        const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...this.options.signal ? [this.options.signal] : []];
        const response = await (this.options.fetcher ?? fetch)(url, { redirect: 'error',
          headers: { accept: ABBREVIATED }, signal: AbortSignal.any(signals) });
        if (response.status !== 200) {
          await response.body?.cancel();
          result = failed('unavailable', response.status === 404 ? 'package is not published' : 'registry error',
            response.status);
        } else {
          const remaining = npmRegistryLimits.totalPacumentBytes - this.bytes;
          const body = await bounded(response, Math.min(npmRegistryLimits.packumentBytes, remaining));
          this.bytes += body.length;
          if (body.exceeded || !body.bytes) result = failed('budget-exhausted', 'packument byte limit', 200, body.length);
          else {
            this.options.observe?.(url, body.bytes);
            result = projectNpmPackument(name, body.bytes);
          }
        }
      } catch (error) {
        this.checkCancelled();
        result = failed('unavailable', error instanceof Error && error.name === 'TimeoutError'
          ? 'registry request timed out' : 'registry request failed');
      }
    }
    this.captured.set(name, result);
    return result;
  }
}

/** Replays a retained snapshot without provider access. */
export class StoredNpmRegistrySource implements NpmRegistrySource {
  private readonly packuments: Map<string, NpmRegistryPackument>;
  constructor(snapshot: NpmRegistrySnapshot) {
    this.packuments = new Map(snapshot.packuments.map(item => [item.name, item]));
  }
  async packument(name: string): Promise<NpmRegistryPackument> {
    const found = this.packuments.get(name);
    if (!found) throw new Error(`retained npm snapshot lacks ${name}`);
    return found;
  }
}

const SRI = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/;
function strongest(integrity: string): { algorithm: string; digest: string } | null {
  const order = ['sha512', 'sha384', 'sha256', 'sha1'];
  const parsed = integrity.trim().split(/\s+/).map(item => SRI.exec(item.split('?')[0]!))
    .filter((match): match is RegExpExecArray => !!match)
    .map(match => ({ algorithm: match[1]!, digest: match[2]! }));
  return parsed.sort((a, b) => order.indexOf(a.algorithm) - order.indexOf(b.algorithm))[0] ?? null;
}

/** Downloads each selected tarball from the fixed origin and checks its registry SRI. */
export async function verifyNpmArtifacts(targets: Array<{ name: string; version: string; tarball: string;
  integrity: string }>, options: NpmRegistryCaptureOptions = {}): Promise<NpmRegistryArtifact[]> {
  const results: NpmRegistryArtifact[] = [];
  let total = 0;
  for (const target of targets) {
    if (options.signal?.aborted) throw new NpmRegistryCancelled('npm artifact verification was cancelled');
    const expected = strongest(target.integrity)!;
    const base = { ...target, algorithm: expected.algorithm, observed: null, byteLength: null, httpStatus: null };
    try {
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2), ...options.signal ? [options.signal] : []];
      const response = await (options.fetcher ?? fetch)(target.tarball, { redirect: 'error',
        signal: AbortSignal.any(signals) });
      if (response.status !== 200) {
        await response.body?.cancel();
        results.push({ ...base, status: 'unavailable', httpStatus: response.status });
        continue;
      }
      const hash = createHash(expected.algorithm);
      const body = await bounded(response, Math.min(npmRegistryLimits.artifactBytes,
        npmRegistryLimits.totalArtifactBytes - total), hash);
      total += body.length;
      if (body.exceeded) {
        results.push({ ...base, status: 'budget-exhausted', byteLength: body.length, httpStatus: 200 });
        continue;
      }
      const observed = hash.digest('base64');
      results.push({ ...base, status: observed === expected.digest ? 'verified' : 'integrity-mismatch',
        observed: `${expected.algorithm}-${observed}`, byteLength: body.length, httpStatus: 200 });
    } catch {
      if (options.signal?.aborted) throw new NpmRegistryCancelled('npm artifact verification was cancelled');
      results.push({ ...base, status: 'unavailable' });
    }
  }
  return results;
}

type Solved = Awaited<ReturnType<typeof solveNpmRegistry>>;
function artifactTargets(solved: Solved['outcome']): Array<{ name: string; version: string; tarball: string;
  integrity: string }> | { failure: 'unsupported' | 'missing'; name: string; version: string } {
  const unique = new Map<string, { name: string; version: string; tarball: string; integrity: string }>();
  for (const instance of solved.instances) {
    if (instance.kind !== 'registry' || !instance.active) continue;
    if (!instance.resolved || !instance.integrity || !strongest(instance.integrity)) {
      return { failure: 'missing', name: instance.name, version: instance.version };
    }
    if (!npmRegistryTarballAllowed(instance.name, instance.resolved)) {
      return { failure: 'unsupported', name: instance.name, version: instance.version };
    }
    unique.set(instance.resolved, { name: instance.name, version: instance.version,
      tarball: instance.resolved, integrity: instance.integrity });
  }
  return [...unique.values()].sort((a, b) => a.tarball < b.tarball ? -1 : a.tarball > b.tarball ? 1 : 0);
}

/** Combines a solve with retained artifact observations into the receipt outcome. */
function assemble(request: NpmRegistryRequest, requestDigest: string, solved: Solved,
  packuments: NpmRegistryPackument[], artifacts: NpmRegistryArtifact[] | null, deadlineExceeded: string | null):
  NpmRegistryOutcome {
  const retained = packuments.map(item => retainNpmCandidates(item, solved.names.get(item.name)))
    .sort((a, b) => a.name < b.name ? -1 : 1);
  const retainedRecords = retained.reduce((sum, item) => sum + item.records.length, 0);
  const sourceSnapshot: NpmRegistrySnapshot = { origin: NPM_REGISTRY_ORIGIN, packuments: retained,
    artifacts: artifacts ?? [], deadlineExceeded };
  const snapshotDigest = npmSha(npmStable(sourceSnapshot));
  const resolutionId = npmSha(npmStable([requestDigest, snapshotDigest]));
  const rebind = (id: string) => npmSha(npmStable([resolutionId, id]));
  let outcome: NpmRegistryOutcome = { ...solved.outcome, resolutionId, snapshotDigest,
    instances: solved.outcome.instances.map(item => ({ ...item, id: rebind(item.id) })),
    omitted: solved.outcome.omitted.map(item => ({ ...item, id: rebind(item.id) })),
    artifactVerification: solved.outcome.status !== 'solved' ? 'not-reached'
      : request.artifacts === 'metadata-only' ? 'not-requested' : 'verified',
    cost: { ...solved.outcome.cost, retainedRecords, artifacts: artifacts?.length ?? 0,
      artifactBytes: (artifacts ?? []).reduce((sum, item) => sum + (item.byteLength ?? 0), 0) },
    sourceSnapshot };
  const fail = (status: NpmRegistryOutcome['status'], extra: Partial<NpmRegistryOutcome>): NpmRegistryOutcome => ({
    ...outcome, status, instances: [], edges: [], omitted: [], engineWarnings: [], artifactVerification: 'failed',
    ...extra });
  if (retainedRecords > npmRegistryLimits.retainedRecords) {
    return fail('budget-exhausted', { budgetReason: 'retained candidate record limit', artifactVerification: 'not-reached' });
  }
  if (outcome.status !== 'solved' || request.artifacts === 'metadata-only') return outcome;
  const targets = artifactTargets(solved.outcome);
  if (!Array.isArray(targets)) {
    return targets.failure === 'unsupported'
      ? fail('unsupported-semantics', { unsupportedClauses: ['artifact:origin'] })
      : fail('incomplete-source-data', { issues: [{ kind: 'unavailable-artifact', name: targets.name,
        version: targets.version, detail: 'registry record has no tarball or SRI' }] });
  }
  if (targets.length > npmRegistryLimits.artifacts) return fail('budget-exhausted', { budgetReason: 'artifact count limit' });
  const observed = artifacts ?? [];
  if (npmStable(observed.map(item => [item.tarball, item.integrity]))
    !== npmStable(targets.map(item => [item.tarball, item.integrity]))) {
    throw new Error('retained npm artifact observations differ from the solved graph');
  }
  const mismatch = observed.filter(item => item.status === 'integrity-mismatch');
  const unavailable = observed.filter(item => item.status === 'unavailable');
  if (mismatch.length) {
    return fail('inconsistent-source-data', { issues: mismatch.map(item => ({ kind: 'integrity-mismatch' as const,
      name: item.name, version: item.version, detail: `expected ${item.integrity}, observed ${item.observed}` })) });
  }
  if (observed.some(item => item.status === 'budget-exhausted')) return fail('budget-exhausted', { budgetReason: 'artifact byte limit' });
  if (unavailable.length) {
    return fail('incomplete-source-data', { issues: unavailable.map(item => ({ kind: 'unavailable-artifact' as const,
      name: item.name, version: item.version, detail: `tarball unavailable (${item.httpStatus ?? 'network'})` })) });
  }
  outcome = { ...outcome, artifactVerification: 'verified' };
  return outcome;
}

/** Live path: capture only reached packuments, solve, then verify selected artifacts. */
export async function resolveNpmRegistry(request: NpmRegistryRequest, requestDigest: string,
  options: NpmRegistryCaptureOptions = {}): Promise<NpmRegistryOutcome> {
  const capture = new NpmRegistryCapture(options);
  const solved = await solveNpmRegistry(request, capture);
  capture.checkCancelled();
  let artifacts: NpmRegistryArtifact[] | null = null;
  if (solved.outcome.status === 'solved' && request.artifacts === 'verify-sri') {
    const targets = artifactTargets(solved.outcome);
    if (Array.isArray(targets) && targets.length <= npmRegistryLimits.artifacts) {
      artifacts = await verifyNpmArtifacts(targets, options);
    }
  }
  return assemble(request, requestDigest, solved, [...capture.captured.values()], artifacts, capture.exceededAt);
}

/** Offline path: re-solve from the retained snapshot and rebuild the exact outcome. */
export async function revalidateNpmRegistry(request: NpmRegistryRequest, requestDigest: string,
  snapshot: NpmRegistrySnapshot): Promise<NpmRegistryOutcome> {
  const solved = await solveNpmRegistry(request, new StoredNpmRegistrySource(snapshot));
  return assemble(request, requestDigest, solved, snapshot.packuments,
    solved.outcome.status === 'solved' && request.artifacts === 'verify-sri' ? snapshot.artifacts : null,
    snapshot.deadlineExceeded);
}
