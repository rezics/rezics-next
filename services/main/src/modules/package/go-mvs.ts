import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { GoProxyCaptureStore } from './go-proxy-capture.ts';
import { parseGoModRequirements } from './go-mod-parser.ts';

export class GoResolutionInvalid extends Error {}
export class GoResolutionConflict extends Error {}
export class GoResolutionUnavailable extends Error {}

export interface GoModuleRequirement { path: string; version: string }
export interface GoModuleManifest extends GoModuleRequirement {
  requirements: GoModuleRequirement[];
  declaredModule?: string;
  retractions?: Array<{ lower: string; upper: string; rationale: string }>;
}
export interface GoModuleReplacement {
  original: GoModuleRequirement;
  source: GoModuleRequirement;
}
export interface GoMvsSnapshotRequest {
  profile: 'go-mvs-stable-unpruned-v1' | 'go-mvs-stable-unpruned-main-directives-v2'
    | 'go-mvs-captured-unpruned-v3';
  mainModule: string;
  goDirective: '1.16';
  coverage: { complete: boolean; unsupportedClauses: string[] };
  roots: GoModuleRequirement[];
  releases: GoModuleManifest[];
  mainDirectives?: { exclusions: GoModuleRequirement[];
    replacements: GoModuleReplacement[] };
  captureEvidence?: Array<{ captureId: string; path: string; version: string;
    listSha256: string; infoSha256: string; modSha256: string }>;
  mainManifest?: { text: string; rawSha256: string };
}
export interface GoCapturedResolutionRequest {
  profile: 'go-mvs-from-captures-v1' | 'go-mvs-from-main-captures-v2';
  mainModule?: string;
  roots?: GoModuleRequirement[];
  mainManifestBase64?: string;
  captures: string[];
}

export interface GoMvsOutcome {
  status: 'solved' | 'incomplete-source-data' | 'unsupported-semantics'
    | 'budget-exhausted';
  buildList: GoModuleRequirement[];
  missing: GoModuleRequirement[];
  unsupportedClauses: string[];
  loadedManifestCount: number;
  requirementCount: number;
  selectedSources?: GoModuleReplacement[];
  retractedSelected?: Array<{ selected: GoModuleRequirement;
    announcedBy: GoModuleRequirement; rationale: string }>;
}

export interface GoMvsResolution {
  profile: 'go-mvs-stable-unpruned-resolution-v1'
    | 'go-mvs-stable-unpruned-main-directives-resolution-v2'
    | 'go-mvs-captured-unpruned-resolution-v3';
  resolution: string;
  requestDigest: string;
  request: GoMvsSnapshotRequest;
  outcome: GoMvsOutcome;
  createdAt: string;
}

interface Row {
  id: string; principal_id: string; idempotency_key: string;
  request_digest: string; request: GoMvsSnapshotRequest;
  outcome: GoMvsOutcome; created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const PATH = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const VERSION = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const MAX_LOADED = 128;
const MAX_REQUIREMENTS = 512;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function versionParts(version: string): [number, number, number] {
  const match = VERSION.exec(version);
  if (!match) throw new GoResolutionInvalid('stable Go module tag is required');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

export function validateGoModuleRequirement(requirement: GoModuleRequirement): void {
  if (!requirement || typeof requirement.path !== 'string'
    || typeof requirement.version !== 'string'
    || requirement.path.length > 200 || !PATH.test(requirement.path)) {
    throw new GoResolutionInvalid('Go module path is outside the stable snapshot profile');
  }
  const [major] = versionParts(requirement.version);
  const suffix = /\/v([0-9]+)$/.exec(requirement.path);
  if ((major! >= 2 && suffix?.[1] !== String(major))
    || (major! < 2 && suffix !== null)) {
    throw new GoResolutionInvalid('Go module path and major version differ');
  }
}

function validateRequest(input: GoMvsSnapshotRequest): void {
  const v2 = input.profile === 'go-mvs-stable-unpruned-main-directives-v2';
  const v3 = input.profile === 'go-mvs-captured-unpruned-v3';
  if ((input.profile !== 'go-mvs-stable-unpruned-v1' && !v2 && !v3)
    || input.goDirective !== '1.16'
    || !PATH.test(input.mainModule) || input.mainModule.length > 200
    || typeof input.coverage?.complete !== 'boolean'
    || !Array.isArray(input.coverage.unsupportedClauses)
    || input.coverage.unsupportedClauses.length > 16
    || input.coverage.unsupportedClauses.some(clause => typeof clause !== 'string'
      || !clause || clause.length > 200)
    || !Array.isArray(input.roots) || input.roots.length > 128
    || !Array.isArray(input.releases) || input.releases.length > 256
    || (v2 && (!input.mainDirectives
      || !Array.isArray(input.mainDirectives.exclusions)
      || input.mainDirectives.exclusions.length > 64
      || !Array.isArray(input.mainDirectives.replacements)
      || input.mainDirectives.replacements.length > 32))
    || (!v2 && input.mainDirectives !== undefined)
    || (v3 && (!Array.isArray(input.captureEvidence)
      || input.captureEvidence.length !== input.releases.length))
    || (!v3 && (input.captureEvidence !== undefined
      || input.mainManifest !== undefined))) {
    throw new GoResolutionInvalid('invalid bounded Go module snapshot');
  }
  const seen = new Set<string>();
  for (const requirement of input.roots) validateGoModuleRequirement(requirement);
  for (const release of input.releases) {
    validateGoModuleRequirement(release);
    if (!Array.isArray(release.requirements) || release.requirements.length > 64) {
      throw new GoResolutionInvalid('Go manifest requirement list exceeds profile');
    }
    const key = `${release.path}\0${release.version}`;
    if (seen.has(key)) throw new GoResolutionInvalid('duplicate Go release manifest');
    seen.add(key);
    if (release.declaredModule !== undefined
      && (!v2 || typeof release.declaredModule !== 'string'
        || !PATH.test(release.declaredModule)
        || release.declaredModule.length > 200)) {
      throw new GoResolutionInvalid('invalid declared Go module path');
    }
    if (release.retractions !== undefined) {
      if (!v2 || release.declaredModule !== undefined
        || !Array.isArray(release.retractions) || release.retractions.length > 16) {
        throw new GoResolutionInvalid('invalid Go retraction metadata');
      }
      for (const retraction of release.retractions) {
        if (!retraction || typeof retraction.lower !== 'string'
          || typeof retraction.upper !== 'string'
          || typeof retraction.rationale !== 'string'
          || !retraction.rationale || retraction.rationale.length > 200
          || compareVersion(retraction.lower, retraction.upper) > 0) {
          throw new GoResolutionInvalid('invalid Go retraction interval');
        }
      }
    }
    for (const requirement of release.requirements) validateGoModuleRequirement(requirement);
  }
  if (v3 && input.captureEvidence) {
    const evidence = new Map<string, typeof input.captureEvidence[number]>();
    for (const item of input.captureEvidence) {
      const requirement = { path: item.path, version: item.version };
      validateGoModuleRequirement(requirement);
      const key = `${item.path}\0${item.version}`;
      if (!UUID.test(item.captureId) || evidence.has(key)
        || ![item.listSha256, item.infoSha256, item.modSha256]
          .every(value => /^[0-9a-f]{64}$/.test(value))) {
        throw new GoResolutionInvalid('invalid Go capture evidence');
      }
      evidence.set(key, item);
    }
    if (input.releases.some(release => !evidence.has(`${release.path}\0${release.version}`))) {
      throw new GoResolutionInvalid('Go capture evidence does not cover releases');
    }
  }
  if (v3 && input.mainManifest !== undefined) {
    const source = input.mainManifest;
    if (!source || typeof source.text !== 'string'
      || Buffer.byteLength(source.text) > 65_536
      || source.rawSha256 !== createHash('sha256').update(source.text).digest('hex')) {
      throw new GoResolutionInvalid('invalid retained Go main manifest');
    }
    const parsed = parseGoModRequirements(source.text, input.mainModule);
    if (parsed.declaredModule !== input.mainModule
      || (parsed.status === 'parsed'
        ? stable(parsed.requirements) !== stable(input.roots)
        : input.roots.length !== 0)
      || (!parsed.compatibleWithUnprunedGo116
        && input.coverage.unsupportedClauses.length === 0)) {
      throw new GoResolutionInvalid('Go main manifest differs from resolved roots');
    }
  }
  if (v2 && input.mainDirectives) {
    const excludes = new Set<string>();
    for (const exclusion of input.mainDirectives.exclusions) {
      validateGoModuleRequirement(exclusion);
      const key = `${exclusion.path}\0${exclusion.version}`;
      if (excludes.has(key)) throw new GoResolutionInvalid('duplicate Go exclusion');
      excludes.add(key);
    }
    const replacements = new Set<string>();
    for (const replacement of input.mainDirectives.replacements) {
      validateGoModuleRequirement(replacement.original);
      validateGoModuleRequirement(replacement.source);
      const key = `${replacement.original.path}\0${replacement.original.version}`;
      if (key === `${replacement.source.path}\0${replacement.source.version}`) {
        throw new GoResolutionInvalid('Go replacement cannot name the same release');
      }
      if (replacements.has(key)) throw new GoResolutionInvalid('duplicate Go replacement');
      replacements.add(key);
    }
  }
}

/** Go 1.16 unpruned MVS: visit every required version, select the maximum per path. */
export function solveGoMvsSnapshot(input: GoMvsSnapshotRequest): GoMvsOutcome {
  validateRequest(input);
  const v2 = input.profile === 'go-mvs-stable-unpruned-main-directives-v2';
  const replacements = new Map((input.mainDirectives?.replacements ?? []).map(item =>
    [`${item.original.path}\0${item.original.version}`, item.source]));
  const exclusions = new Set((input.mainDirectives?.exclusions ?? []).map(item =>
    `${item.path}\0${item.version}`));
  const selectedSources = new Map<string, GoModuleReplacement>();
  const hasRetractions = v2 && input.releases.some(item => item.retractions !== undefined);
  const latest = new Map<string, GoModuleManifest>();
  if (hasRetractions) {
    for (const release of input.releases) {
      if (release.declaredModule !== undefined) continue;
      const current = latest.get(release.path);
      if (!current || compareVersion(release.version, current.version) > 0) {
        latest.set(release.path, release);
      }
    }
  }
  const extra = v2 ? { selectedSources: [] as GoModuleReplacement[] } : {};
  const advisory = hasRetractions ? { retractedSelected: [] as NonNullable<
    GoMvsOutcome['retractedSelected']> } : {};
  if (input.coverage.unsupportedClauses.length) {
    return { status: 'unsupported-semantics', buildList: [], missing: [],
      unsupportedClauses: input.coverage.unsupportedClauses,
      loadedManifestCount: 0, requirementCount: 0, ...extra, ...advisory };
  }
  const manifest = new Map(input.releases.map(release =>
    [`${release.path}\0${release.version}`, release]));
  const queue = [...input.roots];
  const visited = new Set<string>();
  const maxima = new Map<string, string>();
  const missing = new Map<string, GoModuleRequirement>();
  let count = 0;
  let loaded = 0;
  for (let offset = 0; offset < queue.length; offset++) {
    count++;
    if (count > MAX_REQUIREMENTS) return { status: 'budget-exhausted', buildList: [],
      missing: [], unsupportedClauses: [], loadedManifestCount: loaded,
      requirementCount: count, ...extra, ...advisory };
    const requirement = queue[offset]!;
    const key = `${requirement.path}\0${requirement.version}`;
    if (exclusions.has(key)) continue;
    const current = maxima.get(requirement.path);
    if (!current || compareVersion(requirement.version, current) > 0) {
      maxima.set(requirement.path, requirement.version);
    }
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > MAX_LOADED) return { status: 'budget-exhausted', buildList: [],
      missing: [], unsupportedClauses: [], loadedManifestCount: loaded,
      requirementCount: count, ...extra, ...advisory };
    const source = replacements.get(key) ?? requirement;
    const release = manifest.get(`${source.path}\0${source.version}`);
    if (!release) {
      missing.set(`${source.path}\0${source.version}`, source);
      continue;
    }
    if ((release.declaredModule ?? release.path) !== requirement.path) {
      throw new GoResolutionInvalid('replacement go.mod module path differs from original');
    }
    if (source !== requirement) {
      selectedSources.set(key, { original: requirement, source });
    }
    loaded++;
    queue.push(...release.requirements);
  }
  const sortedMissing = [...missing.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || compareVersion(a.version, b.version));
  const common = { buildList: [] as GoModuleRequirement[], missing: sortedMissing,
    unsupportedClauses: input.coverage.unsupportedClauses,
    loadedManifestCount: loaded, requirementCount: count, ...extra, ...advisory };
  if (!input.coverage.complete || sortedMissing.length) {
    return { ...common, status: 'incomplete-source-data' };
  }
  const buildList = [...maxima]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, version]) => ({ path, version }));
  const buildKeys = new Set(buildList.map(item => `${item.path}\0${item.version}`));
  const sourceOwner = new Map<string, string>();
  for (const [original, replacement] of selectedSources) {
    const source = `${replacement.source.path}\0${replacement.source.version}`;
    if (buildKeys.has(source) || sourceOwner.has(source)) {
      throw new GoResolutionInvalid('Go replacement source is also selected elsewhere');
    }
    sourceOwner.set(source, original);
  }
  return { ...common, status: 'solved', buildList,
    ...(v2 ? { selectedSources: buildList.flatMap(item => {
      const source = selectedSources.get(`${item.path}\0${item.version}`);
      return source ? [source] : [];
    }) } : {}),
    ...(hasRetractions ? { retractedSelected: buildList.flatMap(selected => {
      const source = latest.get(selected.path);
      if (!source) return [];
      return (source.retractions ?? []).filter(item =>
        compareVersion(item.lower, selected.version) <= 0
        && compareVersion(selected.version, item.upper) <= 0)
        .map(item => ({ selected,
          announcedBy: { path: source.path, version: source.version },
          rationale: item.rationale }));
    }) } : {}) };
}

export class GoMvsResolutionStore {
  constructor(private readonly pool: Pool,
    private readonly captures?: GoProxyCaptureStore) {}

  private verified(row: Row): GoMvsResolution {
    const expected = solveGoMvsSnapshot(row.request);
    if (row.request_digest !== digest(row.request)
      || stable(row.outcome) !== stable(expected)) {
      throw new GoResolutionUnavailable('stored Go resolution differs from its snapshot');
    }
    return { profile: row.request.profile === 'go-mvs-stable-unpruned-v1'
      ? 'go-mvs-stable-unpruned-resolution-v1'
      : row.request.profile === 'go-mvs-stable-unpruned-main-directives-v2'
        ? 'go-mvs-stable-unpruned-main-directives-resolution-v2'
        : 'go-mvs-captured-unpruned-resolution-v3',
      resolution: `https://rezics.com/id/${row.id}`,
      requestDigest: row.request_digest, request: row.request,
      outcome: row.outcome, createdAt: row.created_at.toISOString() };
  }

  async resolve(principalId: string, key: string, input: GoMvsSnapshotRequest):
    Promise<{ resolution: GoMvsResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) {
      throw new GoResolutionInvalid('invalid Go resolution identity or idempotency key');
    }
    const outcome = solveGoMvsSnapshot(input);
    const requestDigest = digest(input);
    const inserted = await this.pool.query(`INSERT INTO pkg.go_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, requestDigest,
      JSON.stringify(input), JSON.stringify(outcome)]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.go_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== requestDigest) {
      throw new GoResolutionConflict('Go resolution key binds another snapshot');
    }
    return { resolution: this.verified(row), replayed: inserted.rowCount === 0 };
  }

  async read(principalId: string, resolutionId: string): Promise<GoMvsResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(resolutionId)) {
      throw new GoResolutionInvalid('invalid Go resolution identity');
    }
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.go_resolution
      WHERE id = $1 AND principal_id = $2`, [resolutionId, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }

  async resolveFromCaptures(principalId: string, key: string,
    input: GoCapturedResolutionRequest):
    Promise<{ resolution: GoMvsResolution; replayed: boolean }> {
    if (!this.captures) throw new GoResolutionUnavailable('Go capture owner is unavailable');
    if (!Array.isArray(input.captures) || input.captures.length > 128) {
      throw new GoResolutionInvalid('invalid captured Go resolution request');
    }
    let mainModule: string;
    let roots: GoModuleRequirement[];
    let mainManifest: GoMvsSnapshotRequest['mainManifest'];
    const unsupportedClauses: string[] = [];
    if (input.profile === 'go-mvs-from-captures-v1') {
      if (typeof input.mainModule !== 'string' || !Array.isArray(input.roots)
        || input.roots.length > 128 || input.mainManifestBase64 !== undefined) {
        throw new GoResolutionInvalid('invalid caller-rooted Go request');
      }
      mainModule = input.mainModule;
      roots = input.roots;
    } else if (input.profile === 'go-mvs-from-main-captures-v2') {
      const encoded = input.mainManifestBase64;
      if (typeof encoded !== 'string' || encoded.length > 87_384
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        || input.mainModule !== undefined || input.roots !== undefined) {
        throw new GoResolutionInvalid('invalid Go main manifest input');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 65_536 || bytes.toString('base64') !== encoded) {
        throw new GoResolutionInvalid('Go main manifest exceeds profile');
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new GoResolutionInvalid('Go main manifest is not UTF-8'); }
      const parsed = parseGoModRequirements(text);
      if (!parsed.declaredModule) {
        throw new GoResolutionInvalid('Go main manifest has no module identity');
      }
      mainModule = parsed.declaredModule;
      roots = parsed.requirements;
      mainManifest = { text, rawSha256: createHash('sha256').update(bytes).digest('hex') };
      if (parsed.status !== 'parsed') {
        unsupportedClauses.push(`main go.mod: ${parsed.unsupportedClauses.join('; ')}`.slice(0, 200));
      } else if (!parsed.compatibleWithUnprunedGo116) {
        unsupportedClauses.push(`main go.mod: go directive ${parsed.goDirective ?? 'absent'}`);
      }
    } else throw new GoResolutionInvalid('invalid captured Go resolution profile');
    const captured = await this.captures.readMany(principalId, input.captures);
    const releases: GoModuleManifest[] = [];
    const captureEvidence: NonNullable<GoMvsSnapshotRequest['captureEvidence']> = [];
    for (let index = 0; index < captured.length; index++) {
      const item = captured[index]!;
      const parsed = item.manifest.parsed;
      if (parsed.status !== 'parsed' || !parsed.compatibleWithUnprunedGo116) {
        if (unsupportedClauses.length < 16) {
          unsupportedClauses.push(`${item.path}@${item.version}: ${parsed.status === 'parsed'
            ? `go directive ${parsed.goDirective ?? 'absent'}` : 'unsupported go.mod syntax'}`);
        }
      }
      releases.push({ path: item.path, version: item.version,
        requirements: parsed.requirements });
      captureEvidence.push({ captureId: input.captures[index]!, path: item.path,
        version: item.version, listSha256: item.versionList.rawSha256,
        infoSha256: item.info.rawSha256, modSha256: item.manifest.rawSha256 });
    }
    const request: GoMvsSnapshotRequest = {
      profile: 'go-mvs-captured-unpruned-v3', mainModule,
      goDirective: '1.16', coverage: { complete: true, unsupportedClauses },
      roots, releases, captureEvidence, ...(mainManifest ? { mainManifest } : {}),
    };
    return this.resolve(principalId, key, request);
  }
}
