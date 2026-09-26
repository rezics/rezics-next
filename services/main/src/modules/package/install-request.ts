import { CargoResolutionInvalid, type CargoRequest } from './cargo-resolution.ts';
import { NpmResolutionInvalid } from './npm-resolution.ts';
import type { NpmRegistryRequest } from './npm-registry.ts';
import { PackageLockInvalid, type PackageLockRequest } from './lock.ts';
import { readMainPackageRecommendations, type PackageReleaseRecommendation }
  from './release-recommendation.ts';
import { hash } from '../work/activate.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const cargoName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const sha256 = /^[0-9a-f]{64}$/;
const MAX_CARGO_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_CARGO_TOTAL_BYTES = 256 * 1024 * 1024;

export class PackageInstallRequestInvalid extends Error {}
export class PackageInstallRequestUnavailable extends Error {}

export interface PackageInstallEnvironment {
  os: 'linux' | 'win32';
  cpu: 'x64' | 'arm64';
  nodeVersion: string;
  cargoHost: 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
  cargoTarget: 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
}
export interface PackageInstallRequestInput {
  mainVersion: string;
  recommendationRevision: string;
  environment: PackageInstallEnvironment;
  cargoIndexFiles?: CargoRequest['indexFiles'];
  cargoArtifacts?: Array<{ name: string; version: string; bytesBase64: string }>;
}
export interface PackageInstallRequestResult {
  profile: 'main-version-package-install-request-v1';
  status: 'resolved' | 'refused';
  reason?: 'unsupported-ecosystem' | 'unsupported-selector' | 'no-eligible-release'
    | 'artifact-unverified' | 'source-incomplete' | 'budget-exhausted';
  recommendationRevision: string;
  resolutions: Array<{ ecosystem: 'npm' | 'cargo'; resolution: string; profile: string }>;
  lock: string | null;
  lockSha256: string | null;
  environment: PackageInstallEnvironment;
  replayed: boolean;
}

function base64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }

function npmRequest(recommendations: PackageReleaseRecommendation[], environment: PackageInstallEnvironment):
  NpmRegistryRequest {
  const dependencies = Object.fromEntries(recommendations.map(item => [item.packageName,
    item.selector.kind === 'exact-release' ? item.selector.value : item.selector.value]));
  const manifestBytes = Buffer.from(JSON.stringify({ name: 'rezics-main-version-install', version: '1.0.0', dependencies }));
  return { profile: 'npm-registry-range-v1', npmVersion: '11.19.1',
    policy: 'npm-strict-peers-advisory-engines-v1', strategy: 'npm-hoisted',
    registry: 'https://registry.npmjs.org/', target: { os: environment.os, cpu: environment.cpu },
    engineTarget: { nodeVersion: environment.nodeVersion, npmVersion: '11.19.1' },
    artifacts: 'verify-sri', manifest: { bytesBase64: base64(manifestBytes), sha256: hash(manifestBytes) },
    workspaces: [] };
}

function cargoRequest(recommendations: PackageReleaseRecommendation[], input: PackageInstallRequestInput):
  CargoRequest {
  const indexFiles = input.cargoIndexFiles;
  if (!indexFiles || !indexFiles.length || !input.cargoArtifacts) {
    throw new PackageInstallRequestInvalid('Cargo install requests require bounded index and archive evidence');
  }
  const dependencies = recommendations.map(item => {
    if (!cargoName.test(item.packageName)) throw new PackageInstallRequestInvalid('invalid Cargo coordinate');
    const version = item.selector.kind === 'exact-release' ? item.selector.value
      : item.selector.value.startsWith('=') ? item.selector.value.slice(1) : '';
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new PackageInstallRequestInvalid('Cargo profile supports exact release selectors only');
    }
    return `${item.packageName} = { version = ${JSON.stringify(`=${version}`)}, registry = "snapshot" }`;
  }).join('\n');
  const manifest = `[package]\nname = "rezics-main-version-install"\nversion = "0.1.0"\nedition = "2021"\nresolver = "2"\n\n[dependencies]\n${dependencies}\n`;
  const bytes = Buffer.from(manifest);
  return { profile: 'cargo-index-exact-resolver2-v3', registryIndexUrl: 'https://index.crates.io/',
    manifestBase64: base64(bytes), manifestSha256: hash(bytes), indexFiles,
    host: input.environment.cargoHost, target: input.environment.cargoTarget,
    features: [], defaultFeatures: true, existingLock: null };
}

function resolutionId(value: string): string {
  const found = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(value);
  if (!found) throw new PackageInstallRequestUnavailable('resolver returned an invalid receipt reference');
  return found[1]!;
}
function ownerKey(key: string, owner: 'npm' | 'cargo' | 'lock'): string {
  return `${key.slice(0, 105)}-${hash(key).slice(0, 16)}-${owner}`;
}

/** Resolve one exact Main Version recommendation set, then lock only solved concrete artifacts. */
export async function resolveMainVersionInstallRequest(work: MainWorkDependencies,
  principalId: string, key: string, input: PackageInstallRequestInput): Promise<PackageInstallRequestResult> {
  if (!nativeId.test(input.mainVersion) || !nativeId.test(input.recommendationRevision)
    || !keyPattern.test(key) || input.environment?.os !== 'linux' && input.environment?.os !== 'win32'
    || !['x64', 'arm64'].includes(input.environment?.cpu)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.environment.nodeVersion)
    || !['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'].includes(input.environment.cargoHost)
    || !['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'].includes(input.environment.cargoTarget)) {
    throw new PackageInstallRequestInvalid('invalid install request environment or identity');
  }
  const recommendations = await readMainPackageRecommendations(work.environment, input.mainVersion,
    input.recommendationRevision);
  if (recommendations.recommendations.length === 0) {
    return { profile: 'main-version-package-install-request-v1', status: 'refused',
      reason: 'no-eligible-release', recommendationRevision: input.recommendationRevision,
      resolutions: [], lock: null, lockSha256: null, environment: input.environment, replayed: false };
  }
  const unsupported = recommendations.recommendations.filter(item => !['npm', 'cargo'].includes(item.ecosystem));
  if (unsupported.length) return { profile: 'main-version-package-install-request-v1', status: 'refused',
    reason: 'unsupported-ecosystem', recommendationRevision: input.recommendationRevision,
    resolutions: [], lock: null, lockSha256: null, environment: input.environment, replayed: false };
  const npmRecs = recommendations.recommendations.filter(item => item.ecosystem === 'npm');
  const cargoRecs = recommendations.recommendations.filter(item => item.ecosystem === 'cargo');
  const resolutions: PackageInstallRequestResult['resolutions'] = [];
  const segments: PackageLockRequest['segments'] = [];
  const refused = (reason: NonNullable<PackageInstallRequestResult['reason']>) => ({
    profile: 'main-version-package-install-request-v1' as const, status: 'refused' as const, reason,
    recommendationRevision: input.recommendationRevision, resolutions: [], lock: null, lockSha256: null,
    environment: input.environment, replayed: false,
  });
  try {
    if (npmRecs.length) {
      if (!work.packageNpmResolutions) throw new PackageInstallRequestUnavailable('npm resolver is unavailable');
      const solved = await work.packageNpmResolutions.resolve(principalId, ownerKey(key, 'npm'),
        npmRequest(npmRecs, input.environment));
      const outcome = solved.resolution.outcome;
      if (outcome.status !== 'solved') return refused(outcome.status === 'unsatisfiable'
        ? 'no-eligible-release' : outcome.status === 'budget-exhausted' ? 'budget-exhausted' : 'source-incomplete');
      if (outcome.artifactVerification !== 'verified') return refused('artifact-unverified');
      const id = resolutionId(solved.resolution.resolution);
      resolutions.push({ ecosystem: 'npm', resolution: solved.resolution.resolution, profile: solved.resolution.profile });
      segments.push({ ecosystem: 'npm', resolution: id,
        scope: { kind: 'process', label: 'main-version-npm' } });
    }
    if (cargoRecs.length) {
      if (!work.packageCargoResolutions) throw new PackageInstallRequestUnavailable('Cargo resolver is unavailable');
      const request = cargoRequest(cargoRecs, input);
      const solved = await work.packageCargoResolutions.resolve(principalId, ownerKey(key, 'cargo'), request);
      const outcome = solved.resolution.outcome;
      if (outcome.status !== 'solved') return refused(outcome.status === 'unsatisfiable'
        ? 'no-eligible-release' : outcome.status === 'budget-exhausted' ? 'budget-exhausted' : 'source-incomplete');
      const checksums = new Map<string, string>();
      for (const file of request.indexFiles) for (const line of Buffer.from(file.bytesBase64, 'base64')
        .toString('utf8').trimEnd().split('\n')) {
        const item = JSON.parse(line) as { name?: unknown; vers?: unknown; cksum?: unknown };
        if (typeof item.name === 'string' && typeof item.vers === 'string'
          && typeof item.cksum === 'string' && sha256.test(item.cksum)) checksums.set(`${item.name}@${item.vers}`, item.cksum);
      }
      const selected = outcome.selected.filter(item => item.source !== 'root');
      const cargoArtifacts = input.cargoArtifacts!;
      const artifactMap = new Map(cargoArtifacts.map(item => [`${item.name}@${item.version}`, item]));
      if (artifactMap.size !== cargoArtifacts.length || selected.some(item => !artifactMap.has(`${item.name}@${item.version}`))) {
        return refused('artifact-unverified');
      }
      let totalBytes = 0;
      for (const item of selected) {
        const evidence = artifactMap.get(`${item.name}@${item.version}`)!;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(evidence.bytesBase64)
          || evidence.bytesBase64.length > Math.ceil(MAX_CARGO_ARTIFACT_BYTES * 4 / 3)) return refused('artifact-unverified');
        const bytes = Buffer.from(evidence.bytesBase64, 'base64');
        if (bytes.toString('base64') !== evidence.bytesBase64 || bytes.byteLength > MAX_CARGO_ARTIFACT_BYTES) {
          return refused('artifact-unverified');
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_CARGO_TOTAL_BYTES || !checksums.has(`${item.name}@${item.version}`)
          || hash(bytes) !== checksums.get(`${item.name}@${item.version}`)) return refused('artifact-unverified');
        // Retain verified bytes before making a lock that points at them.
        await work.packageLocks?.artifacts.retain(bytes, 'application/vnd.crates-io.crate', null);
      }
      const id = resolutionId(solved.resolution.resolution);
      resolutions.push({ ecosystem: 'cargo', resolution: solved.resolution.resolution, profile: solved.resolution.profile });
      segments.push({ ecosystem: 'cargo', resolution: id,
        scope: { kind: 'path', label: 'main-version-cargo' } });
    }
    if (!work.packageLocks) throw new PackageInstallRequestUnavailable('package lock owner is unavailable');
    const lock = await work.packageLocks.create(principalId, ownerKey(key, 'lock'),
      { profile: 'rezics-package-lock-v1', segments });
    return { profile: 'main-version-package-install-request-v1', status: 'resolved',
      recommendationRevision: input.recommendationRevision, resolutions, lock: lock.lock.lock,
      lockSha256: lock.lock.lockSha256, environment: input.environment, replayed: lock.replayed };
  } catch (error) {
    if (error instanceof CargoResolutionInvalid || error instanceof NpmResolutionInvalid
      || error instanceof PackageLockInvalid || error instanceof PackageInstallRequestInvalid) {
      return refused('unsupported-selector');
    }
    throw error;
  }
}
