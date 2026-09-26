import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { GoProxyCaptureStore } from './go-proxy-capture.ts';
import { parseGoModRequirements } from './go-mod-parser.ts';

export class GoResolutionInvalid extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'malformed'
    | 'changed-digest' | 'duplicate' | 'unsafe-source' = 'invalid') {
    super(message);
  }
}
export class GoResolutionConflict extends Error {}
export class GoResolutionUnavailable extends Error {}

export interface GoModuleRequirement { path: string; version: string }
export interface GoModuleManifest extends GoModuleRequirement {
  requirements: GoModuleRequirement[];
  goDirective?: string | null;
  unsupportedClauses?: string[];
  declaredModule?: string;
  retractions?: Array<{ lower: string; upper: string; rationale: string }>;
}
export interface GoModuleReplacement {
  original: GoModuleRequirement;
  source: GoModuleRequirement;
}
export interface GoModuleReplacementDirective {
  original: { path: string; version?: string };
  source: GoModuleRequirement;
}
export interface GoLocalReplacementDirective {
  original: { path: string; version?: string };
  sourceIdentity: string;
}
export interface GoLocalModuleSource {
  identity: string;
  text: string;
  rawSha256: string;
}
export interface GoMvsSnapshotRequest {
  profile: 'go-mvs-stable-unpruned-v1' | 'go-mvs-stable-unpruned-main-directives-v2'
    | 'go-mvs-captured-unpruned-v3' | 'go-mvs-local-unpruned-v4'
    | 'go-mvs-captured-pruned-v5';
  mainModule: string;
  goDirective: string;
  coverage: { complete: boolean; unsupportedClauses: string[] };
  roots: GoModuleRequirement[];
  releases: GoModuleManifest[];
  mainDirectives?: { exclusions: GoModuleRequirement[];
    replacements: GoModuleReplacementDirective[] };
  captureEvidence?: Array<{ captureId: string; path: string; version: string;
    listSha256?: string; infoSha256: string; modSha256: string;
    selection?: 'exact-pseudo-version' }>;
  mainManifest?: { text: string; rawSha256: string };
  localReplacements?: GoLocalReplacementDirective[];
  localSources?: GoLocalModuleSource[];
}
export interface GoCapturedResolutionRequest {
  profile: 'go-mvs-from-captures-v1' | 'go-mvs-from-main-captures-v2'
    | 'go-mvs-from-main-local-captures-v3' | 'go-mvs-from-main-pruned-captures-v4';
  mainModule?: string;
  roots?: GoModuleRequirement[];
  mainManifestBase64?: string;
  captures: string[];
  localSources?: Array<{ identity: string; goModBase64: string; rawSha256: string }>;
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
  selectedLocalSources?: Array<{ original: GoModuleRequirement;
    sourceIdentity: string; declaredModule: string; rawSha256: string }>;
  missingLocalSources?: string[];
  retractedSelected?: Array<{ selected: GoModuleRequirement;
    announcedBy: GoModuleRequirement; rationale: string }>;
}

export interface GoMvsResolution {
  profile: 'go-mvs-stable-unpruned-resolution-v1'
    | 'go-mvs-stable-unpruned-main-directives-resolution-v2'
    | 'go-mvs-captured-unpruned-resolution-v3'
    | 'go-mvs-local-unpruned-resolution-v4'
    | 'go-mvs-captured-pruned-resolution-v5';
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
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/;
// The admitted pseudo-version forms follow x/mod/module.IsPseudoVersion, without build metadata.
const PSEUDO_VERSION = /^v[0-9]+\.(?:0\.0-|[0-9]+\.[0-9]+-(?:[^+]*\.)?0\.)[0-9]{14}-[A-Za-z0-9]+$/;
const MAX_VERSION_LENGTH = 96;
const MAX_LOADED = 128;
const MAX_REQUIREMENTS = 512;
const LOCAL_IDENTITY = /^\.\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

function supportedGoDirective(value: string | null | undefined,
  main: boolean): boolean {
  if (typeof value !== 'string' || !/^1\.(?:[0-9]+)(?:\.[0-9]+)?$/.test(value)) return false;
  const [major, minor, patch = 0] = value.split('.').map(Number);
  return major === 1 && minor! >= (main ? 17 : 16)
    && (minor! < 27 || (minor === 27 && patch <= 1));
}

function validLocalIdentity(identity: string): boolean {
  return typeof identity === 'string' && identity.length <= 200
    && LOCAL_IDENTITY.test(identity) && !identity.split('/').some(part => part === '..');
}

function decodeManifest(encoded: string, expectedSha256?: string):
  { text: string; rawSha256: string } {
  if (typeof encoded !== 'string' || encoded.length > 87_384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new GoResolutionInvalid('invalid canonical Go manifest base64', 'malformed');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 65_536 || bytes.toString('base64') !== encoded) {
    throw new GoResolutionInvalid('Go manifest exceeds profile', 'malformed');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new GoResolutionInvalid('Go manifest is not UTF-8', 'malformed'); }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new GoResolutionInvalid('Go manifest bytes are not preserved by UTF-8', 'malformed');
  }
  const rawSha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && rawSha256 !== expectedSha256) {
    throw new GoResolutionInvalid('Go local manifest digest differs from supplied bytes',
      'changed-digest');
  }
  return { text, rawSha256 };
}

/** Only main-module, relative local replacements are admitted by the v4 profile. */
export function parseGoLocalMainManifest(text: string): {
  parsed: ReturnType<typeof parseGoModRequirements>;
  replacements: GoLocalReplacementDirective[];
  unsupportedClauses: string[];
} {
  const replacements: GoLocalReplacementDirective[] = [];
  const unsupportedClauses: string[] = [];
  const plain: string[] = [];
  let group = false;
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+\/\/.*$/, '').trim();
    if (line === 'replace (') { if (group) unsupportedClauses.push('nested replace group'); group = true; continue; }
    if (group && line === ')') { group = false; continue; }
    const clause = group ? line : line.startsWith('replace ') ? line.slice(8) : null;
    if (clause === null) { plain.push(raw); continue; }
    if (!clause || clause.startsWith('//')) continue;
    const parts = clause.split(/\s+/);
    const arrow = parts.indexOf('=>');
    if ((arrow !== 1 && arrow !== 2) || parts.length !== arrow + 2) {
      unsupportedClauses.push(`replace ${clause}`.slice(0, 200)); continue;
    }
    const original = { path: parts[0]!, ...(arrow === 2 ? { version: parts[1]! } : {}) };
    const sourceIdentity = parts[arrow + 1]!;
    if (!PATH.test(original.path) || original.path.length > 200) {
      unsupportedClauses.push(`replace ${clause}`.slice(0, 200)); continue;
    }
    if (original.version !== undefined) {
      try { validateGoModuleRequirement(original as GoModuleRequirement); }
      catch { unsupportedClauses.push(`replace ${clause}`.slice(0, 200)); continue; }
    }
    if (!validLocalIdentity(sourceIdentity)) {
      throw new GoResolutionInvalid('Go local source identity must be a bounded ./ relative directory',
        'unsafe-source');
    }
    const key = `${original.path}\0${original.version ?? ''}`;
    if (seen.has(key)) throw new GoResolutionInvalid('duplicate Go local replacement',
      'duplicate');
    seen.add(key);
    replacements.push({ original, sourceIdentity });
  }
  if (group) unsupportedClauses.push('unclosed replace group');
  if (replacements.length > 32) throw new GoResolutionInvalid('Go local replacement budget exceeded');
  const parsed = parseGoModRequirements(plain.join('\n'));
  return { parsed, replacements, unsupportedClauses };
}

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

function versionParts(version: string): { core: [string, string, string]; prerelease: string[] } {
  if (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH) {
    throw new GoResolutionInvalid('Go module version exceeds profile');
  }
  const match = VERSION.exec(version);
  if (!match || (match[4] !== undefined && !PSEUDO_VERSION.test(version))) {
    throw new GoResolutionInvalid('canonical stable tag or Go pseudo-version is required');
  }
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => !/^[0-9A-Za-z-]+$/.test(part)
    || (/^[0-9]+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    throw new GoResolutionInvalid('invalid Go pseudo-version prerelease');
  }
  return { core: [match[1]!, match[2]!, match[3]!], prerelease };
}

export function isAdmittedGoPseudoVersion(version: string): boolean {
  try { versionParts(version); return PSEUDO_VERSION.test(version); }
  catch { return false; }
}

function compareNumeric(left: string, right: string): number {
  return Math.sign(left.length - right.length) || (left < right ? -1 : left > right ? 1 : 0);
}

function compareVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    const compared = compareNumeric(a.core[index]!, b.core[index]!);
    if (compared) return compared;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index]!;
    const rightPart = b.prerelease[index]!;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const compared = leftNumeric ? compareNumeric(leftPart, rightPart)
      : leftPart < rightPart ? -1 : leftPart > rightPart ? 1 : 0;
    if (compared) return compared;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

export function validateGoModuleRequirement(requirement: GoModuleRequirement): void {
  if (!requirement || typeof requirement.path !== 'string'
    || typeof requirement.version !== 'string'
    || requirement.path.length > 200 || !PATH.test(requirement.path)) {
    throw new GoResolutionInvalid('Go module path is outside the stable snapshot profile');
  }
  const major = versionParts(requirement.version).core[0];
  const suffix = /\/v([0-9]+)$/.exec(requirement.path);
  if ((compareNumeric(major!, '2') >= 0 && suffix?.[1] !== major)
    || (compareNumeric(major!, '2') < 0 && suffix !== null)) {
    throw new GoResolutionInvalid('Go module path and major version differ');
  }
}

function validateRequest(input: GoMvsSnapshotRequest): void {
  const v2 = input.profile === 'go-mvs-stable-unpruned-main-directives-v2';
  const v3 = input.profile === 'go-mvs-captured-unpruned-v3';
  const v4 = input.profile === 'go-mvs-local-unpruned-v4';
  const v5 = input.profile === 'go-mvs-captured-pruned-v5';
  if ((input.profile !== 'go-mvs-stable-unpruned-v1' && !v2 && !v3 && !v4 && !v5)
    || (v5 ? (typeof input.goDirective !== 'string'
      || input.goDirective.length > 32
      || (!supportedGoDirective(input.goDirective, true)
        && input.coverage?.unsupportedClauses?.length === 0))
      : input.goDirective !== '1.16')
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
    || ((v3 || v4 || v5) && (!Array.isArray(input.captureEvidence)
      || input.captureEvidence.length !== input.releases.length))
    || (!v3 && !v4 && !v5 && (input.captureEvidence !== undefined
      || input.mainManifest !== undefined))
    || (v5 && !input.mainManifest)
    || (v4 && (!input.mainManifest || !Array.isArray(input.localReplacements)
      || input.localReplacements.length > 32 || !Array.isArray(input.localSources)
      || input.localSources.length > 32))
    || (!v4 && (input.localReplacements !== undefined || input.localSources !== undefined))) {
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
    if (v5) {
      if (release.goDirective === undefined
        || !Array.isArray(release.unsupportedClauses)
        || release.unsupportedClauses.length > 16
        || release.unsupportedClauses.some(clause => typeof clause !== 'string'
          || !clause || clause.length > 200)) {
        throw new GoResolutionInvalid('invalid captured Go pruning metadata');
      }
    } else if (release.goDirective !== undefined
      || release.unsupportedClauses !== undefined) {
      throw new GoResolutionInvalid('Go pruning metadata requires the v5 profile');
    }
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
  if ((v3 || v4 || v5) && input.captureEvidence) {
    const evidence = new Map<string, typeof input.captureEvidence[number]>();
    for (const item of input.captureEvidence) {
      const requirement = { path: item.path, version: item.version };
      validateGoModuleRequirement(requirement);
      const key = `${item.path}\0${item.version}`;
      const exactPseudo = item.selection === 'exact-pseudo-version';
      if (!UUID.test(item.captureId) || evidence.has(key)
        || ![item.infoSha256, item.modSha256]
          .every(value => /^[0-9a-f]{64}$/.test(value))
        || (exactPseudo
          ? item.listSha256 !== undefined || !isAdmittedGoPseudoVersion(item.version)
          : item.selection !== undefined
            || !/^[0-9a-f]{64}$/.test(item.listSha256 ?? ''))) {
        throw new GoResolutionInvalid('invalid Go capture evidence');
      }
      evidence.set(key, item);
    }
    if (input.releases.some(release => !evidence.has(`${release.path}\0${release.version}`))) {
      throw new GoResolutionInvalid('Go capture evidence does not cover releases');
    }
  }
  if ((v3 || v4 || v5) && input.mainManifest !== undefined) {
    const source = input.mainManifest;
    if (!source || typeof source.text !== 'string'
      || Buffer.byteLength(source.text) > 65_536
      || source.rawSha256 !== createHash('sha256').update(source.text).digest('hex')) {
      throw new GoResolutionInvalid('invalid retained Go main manifest');
    }
    const local = v4 ? parseGoLocalMainManifest(source.text) : null;
    const parsed = local?.parsed ?? parseGoModRequirements(source.text, input.mainModule);
    if (parsed.declaredModule !== input.mainModule
      || (parsed.status === 'parsed'
        ? stable(parsed.requirements) !== stable(input.roots)
        : input.roots.length !== 0)
      || (!(v5 ? supportedGoDirective(parsed.goDirective, true)
        : parsed.compatibleWithUnprunedGo116)
        && input.coverage.unsupportedClauses.length === 0)) {
      throw new GoResolutionInvalid('Go main manifest differs from resolved roots');
    }
    if (local && stable(local.replacements) !== stable(input.localReplacements)) {
      throw new GoResolutionInvalid('Go local directives differ from retained main manifest');
    }
  }
  if (v4 && input.localSources) {
    const identities = new Set<string>();
    for (const source of input.localSources) {
      if (!source || !validLocalIdentity(source.identity)) {
        throw new GoResolutionInvalid('invalid Go local source identity', 'unsafe-source');
      }
      if (identities.has(source.identity)) {
        throw new GoResolutionInvalid('duplicate Go local source identity', 'duplicate');
      }
      if (typeof source.text !== 'string' || Buffer.byteLength(source.text) > 65_536) {
        throw new GoResolutionInvalid('invalid Go local source manifest', 'malformed');
      }
      if (source.rawSha256 !== createHash('sha256').update(source.text).digest('hex')) {
        throw new GoResolutionInvalid('Go local source digest differs from supplied bytes',
          'changed-digest');
      }
      identities.add(source.identity);
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
      if (!replacement?.original || typeof replacement.original.path !== 'string'
        || replacement.original.path.length > 200
        || !PATH.test(replacement.original.path)) {
        throw new GoResolutionInvalid('invalid Go replacement target path');
      }
      if (replacement.original.version !== undefined) {
        validateGoModuleRequirement(replacement.original as GoModuleRequirement);
      }
      validateGoModuleRequirement(replacement.source);
      const key = `${replacement.original.path}\0${replacement.original.version ?? ''}`;
      if (replacement.original.version !== undefined
        && key === `${replacement.source.path}\0${replacement.source.version}`) {
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
  if (input.profile === 'go-mvs-captured-pruned-v5') return solvePrunedSnapshot(input);
  const v2 = input.profile === 'go-mvs-stable-unpruned-main-directives-v2';
  const v4 = input.profile === 'go-mvs-local-unpruned-v4';
  const replacements = new Map((input.mainDirectives?.replacements ?? []).map(item =>
    [`${item.original.path}\0${item.original.version ?? ''}`, item.source]));
  const localReplacements = new Map((input.localReplacements ?? []).map(item =>
    [`${item.original.path}\0${item.original.version ?? ''}`, item.sourceIdentity]));
  const localSources = new Map((input.localSources ?? []).map(item => [item.identity, item]));
  const localParsed = new Map((input.localSources ?? []).map(item =>
    [item.identity, parseGoModRequirements(item.text)]));
  const exclusions = new Set((input.mainDirectives?.exclusions ?? []).map(item =>
    `${item.path}\0${item.version}`));
  const selectedSources = new Map<string, GoModuleReplacement>();
  const selectedLocalSources = new Map<string, NonNullable<GoMvsOutcome[
    'selectedLocalSources']>[number]>();
  const missingLocalSources = new Set<string>();
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
  const extra = v2 ? { selectedSources: [] as GoModuleReplacement[] }
    : v4 ? { selectedLocalSources: [] as NonNullable<GoMvsOutcome['selectedLocalSources']>,
      missingLocalSources: [] as string[] } : {};
  const advisory = hasRetractions ? { retractedSelected: [] as NonNullable<
    GoMvsOutcome['retractedSelected']> } : {};
  const localUnsupported = v4 ? input.localSources!.flatMap(source => {
    const parsed = localParsed.get(source.identity)!;
    return parsed.compatibleWithUnprunedGo116 ? []
      : [`${source.identity}: ${parsed.status === 'parsed'
        ? `go directive ${parsed.goDirective ?? 'absent'}` : 'unsupported go.mod syntax'}`];
  }) : [];
  const unsupportedClauses = [...input.coverage.unsupportedClauses, ...localUnsupported];
  if (unsupportedClauses.length) {
    return { status: 'unsupported-semantics', buildList: [], missing: [],
      unsupportedClauses: unsupportedClauses.slice(0, 16),
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
    const localIdentity = localReplacements.get(key)
      ?? localReplacements.get(`${requirement.path}\0`);
    if (localIdentity) {
      const local = localSources.get(localIdentity);
      if (!local) { missingLocalSources.add(localIdentity); continue; }
      const parsed = localParsed.get(localIdentity)!;
      selectedLocalSources.set(key, { original: requirement,
        sourceIdentity: localIdentity, declaredModule: parsed.declaredModule!,
        rawSha256: local.rawSha256 });
      loaded++;
      queue.push(...parsed.requirements);
      continue;
    }
    const source = replacements.get(key)
      ?? replacements.get(`${requirement.path}\0`) ?? requirement;
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
    loadedManifestCount: loaded, requirementCount: count, ...extra, ...advisory,
    ...(v4 ? { missingLocalSources: [...missingLocalSources].sort() } : {}) };
  if (!input.coverage.complete || sortedMissing.length || missingLocalSources.size) {
    return { ...common, status: 'incomplete-source-data' };
  }
  const buildList = [...maxima]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, version]) => ({ path, version }));
  const buildKeys = new Set(buildList.map(item => `${item.path}\0${item.version}`));
  const sourceOwner = new Map<string, string>();
  const localOwner = new Map<string, string>();
  for (const selected of buildList) {
    const original = `${selected.path}\0${selected.version}`;
    const local = selectedLocalSources.get(original);
    if (local) {
      const previous = localOwner.get(local.sourceIdentity);
      if (previous && previous !== selected.path) {
        throw new GoResolutionInvalid('Go local source is selected for multiple module paths',
          'duplicate');
      }
      localOwner.set(local.sourceIdentity, selected.path);
    }
    const replacement = selectedSources.get(original);
    if (!replacement) continue;
    const source = `${replacement.source.path}\0${replacement.source.version}`;
    if (buildKeys.has(source) || sourceOwner.has(source)) {
      throw new GoResolutionInvalid('Go replacement source is also selected elsewhere');
    }
    sourceOwner.set(source, original);
  }
  return { ...common, status: 'solved', buildList,
    ...(v4 ? { selectedLocalSources: buildList.flatMap(item => {
      const source = selectedLocalSources.get(`${item.path}\0${item.version}`);
      return source ? [source] : [];
    }) } : {}),
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

/** Go 1.17+ graph: expand explicit roots, then only branches reached through Go <=1.16. */
function solvePrunedSnapshot(input: GoMvsSnapshotRequest): GoMvsOutcome {
  if (input.coverage.unsupportedClauses.length) return {
    status: 'unsupported-semantics', buildList: [], missing: [],
    unsupportedClauses: input.coverage.unsupportedClauses,
    loadedManifestCount: 0, requirementCount: 0 };
  const manifests = new Map(input.releases.map(release =>
    [`${release.path}\0${release.version}`, release]));
  const queue = input.roots.map(requirement => ({ requirement, expand: true,
    legacyBranch: false }));
  const expanded = new Set<string>();
  const expandedLegacy = new Set<string>();
  const maxima = new Map<string, string>();
  const missing = new Map<string, GoModuleRequirement>();
  let loaded = 0;
  let count = 0;
  for (let offset = 0; offset < queue.length; offset++) {
    count++;
    if (count > MAX_REQUIREMENTS) return { status: 'budget-exhausted', buildList: [],
      missing: [], unsupportedClauses: [], loadedManifestCount: loaded,
      requirementCount: count };
    const { requirement, expand, legacyBranch } = queue[offset]!;
    const key = `${requirement.path}\0${requirement.version}`;
    const current = maxima.get(requirement.path);
    if (!current || compareVersion(requirement.version, current) > 0) {
      maxima.set(requirement.path, requirement.version);
    }
    if (!expand || (expanded.has(key) && (!legacyBranch || expandedLegacy.has(key)))) {
      continue;
    }
    const firstLoad = !expanded.has(key);
    expanded.add(key);
    if (legacyBranch) expandedLegacy.add(key);
    if (expanded.size > MAX_LOADED) return { status: 'budget-exhausted', buildList: [],
      missing: [], unsupportedClauses: [], loadedManifestCount: loaded,
      requirementCount: count };
    const release = manifests.get(key);
    if (!release) { missing.set(key, requirement); continue; }
    if (release.unsupportedClauses!.length
      || !supportedGoDirective(release.goDirective, false)) {
      return { status: 'unsupported-semantics', buildList: [], missing: [],
        unsupportedClauses: (release.unsupportedClauses!.length
          ? release.unsupportedClauses!.map(clause =>
            `${release.path}@${release.version}: ${clause}`.slice(0, 200))
          : [`${release.path}@${release.version}: go directive ${release.goDirective ?? 'absent'}`])
          .slice(0, 16), loadedManifestCount: loaded, requirementCount: count };
    }
    if (firstLoad) loaded++;
    const followTransitive = legacyBranch || release.goDirective === '1.16'
      || release.goDirective?.startsWith('1.16.') === true;
    for (const dependency of release.requirements) {
      queue.push({ requirement: dependency, expand: followTransitive,
        legacyBranch: followTransitive });
    }
  }
  const sortedMissing = [...missing.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || compareVersion(a.version, b.version));
  if (!input.coverage.complete || sortedMissing.length) return {
    status: 'incomplete-source-data', buildList: [], missing: sortedMissing,
    unsupportedClauses: [], loadedManifestCount: loaded, requirementCount: count };
  return { status: 'solved', buildList: [...maxima]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, version]) => ({ path, version })),
  missing: [], unsupportedClauses: [], loadedManifestCount: loaded,
  requirementCount: count };
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
        : row.request.profile === 'go-mvs-captured-pruned-v5'
          ? 'go-mvs-captured-pruned-resolution-v5'
        : row.request.profile === 'go-mvs-local-unpruned-v4'
          ? 'go-mvs-local-unpruned-resolution-v4'
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
    } else if (input.profile === 'go-mvs-from-main-captures-v2'
      || input.profile === 'go-mvs-from-main-local-captures-v3'
      || input.profile === 'go-mvs-from-main-pruned-captures-v4') {
      const encoded = input.mainManifestBase64;
      if (input.mainModule !== undefined || input.roots !== undefined) {
        throw new GoResolutionInvalid('invalid Go main manifest input');
      }
      mainManifest = decodeManifest(encoded!);
      const local = input.profile === 'go-mvs-from-main-local-captures-v3'
        ? parseGoLocalMainManifest(mainManifest.text) : null;
      const parsed = local?.parsed ?? parseGoModRequirements(mainManifest.text);
      if (!parsed.declaredModule) {
        throw new GoResolutionInvalid('Go main manifest has no module identity');
      }
      mainModule = parsed.declaredModule;
      roots = parsed.requirements;
      if (parsed.status !== 'parsed') {
        unsupportedClauses.push(`main go.mod: ${parsed.unsupportedClauses.join('; ')}`.slice(0, 200));
      } else if (!(input.profile === 'go-mvs-from-main-pruned-captures-v4'
        ? supportedGoDirective(parsed.goDirective, true)
        : parsed.compatibleWithUnprunedGo116)) {
        unsupportedClauses.push(`main go.mod: go directive ${parsed.goDirective ?? 'absent'}`
          .slice(0, 200));
      }
      if (local?.unsupportedClauses.length) {
        unsupportedClauses.push(...local.unsupportedClauses.map(clause =>
          `main go.mod: ${clause}`.slice(0, 200)));
      }
    } else throw new GoResolutionInvalid('invalid captured Go resolution profile');
    const captured = await this.captures.readMany(principalId, input.captures);
    const releases: GoModuleManifest[] = [];
    const captureEvidence: NonNullable<GoMvsSnapshotRequest['captureEvidence']> = [];
    const pruned = input.profile === 'go-mvs-from-main-pruned-captures-v4';
    for (let index = 0; index < captured.length; index++) {
      const item = captured[index]!;
      const parsed = item.manifest.parsed;
      if (!pruned && (parsed.status !== 'parsed' || !parsed.compatibleWithUnprunedGo116)) {
        if (unsupportedClauses.length < 16) {
          unsupportedClauses.push(`${item.path}@${item.version}: ${parsed.status === 'parsed'
            ? `go directive ${parsed.goDirective ?? 'absent'}` : 'unsupported go.mod syntax'}`);
        }
      }
      releases.push({ path: item.path, version: item.version,
        requirements: parsed.requirements,
        ...(pruned ? { goDirective: (parsed.goDirective?.length ?? 0) <= 32
          ? parsed.goDirective : null,
        unsupportedClauses: (parsed.goDirective && parsed.goDirective.length > 32
          ? [...parsed.unsupportedClauses, 'go directive exceeds profile']
          : parsed.unsupportedClauses).slice(0, 16) } : {}) });
      captureEvidence.push({ captureId: input.captures[index]!, path: item.path,
        version: item.version,
        ...(item.versionList
          ? { listSha256: item.versionList.rawSha256 }
          : { selection: 'exact-pseudo-version' as const }),
        infoSha256: item.info.rawSha256, modSha256: item.manifest.rawSha256 });
    }
    const v4 = input.profile === 'go-mvs-from-main-local-captures-v3';
    let localSources: GoLocalModuleSource[] | undefined;
    let localReplacements: GoLocalReplacementDirective[] | undefined;
    if (v4) {
      if (!Array.isArray(input.localSources) || input.localSources.length > 32) {
        throw new GoResolutionInvalid('invalid Go local source inventory');
      }
      localSources = input.localSources.map(source => {
        if (!source || !validLocalIdentity(source.identity)) {
          throw new GoResolutionInvalid('invalid Go local source identity', 'unsafe-source');
        }
        return { identity: source.identity,
          ...decodeManifest(source.goModBase64, source.rawSha256) };
      });
      localReplacements = parseGoLocalMainManifest(mainManifest!.text).replacements;
    } else if (input.localSources !== undefined) {
      throw new GoResolutionInvalid('local sources require the v3 caller profile');
    }
    const request: GoMvsSnapshotRequest = {
      profile: pruned ? 'go-mvs-captured-pruned-v5'
        : v4 ? 'go-mvs-local-unpruned-v4' : 'go-mvs-captured-unpruned-v3', mainModule,
      goDirective: pruned ? (parseGoModRequirements(mainManifest!.text).goDirective ?? 'absent')
        .slice(0, 32)
        : '1.16', coverage: { complete: true, unsupportedClauses },
      roots, releases, captureEvidence, ...(mainManifest ? { mainManifest } : {}),
      ...(v4 ? { localSources, localReplacements } : {}),
    };
    return this.resolve(principalId, key, request);
  }
}
