import { createHash } from 'node:crypto';
import { parseGoModRequirements } from './go-mod-parser.ts';
import { compareVersion, GoResolutionInvalid, supportedGoDirective,
  validateGoModuleRequirement, type GoModuleManifest, type GoModuleRequirement,
  type GoMvsOutcome, type GoMvsSnapshotRequest } from './go-mvs.ts';

const moduleKey = (item: GoModuleRequirement) => `${item.path}\0${item.version}`;
const pathPattern = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

/** A new parser entry point leaves historical capture/parser receipts unchanged. */
export function parseGoRemoteMainManifest(text: string) {
  const directives: NonNullable<GoMvsSnapshotRequest['mainDirectives']> = {
    exclusions: [], replacements: [],
  };
  const plain: string[] = [];
  const unsupportedClauses: string[] = [];
  const seen = new Set<string>();
  let group: 'replace' | 'exclude' | null = null;
  let requireGroup = false;
  const unsupported = (line: string) => {
    if (unsupportedClauses.length < 16) unsupportedClauses.push(line.slice(0, 200));
  };
  const admitted = (item: GoModuleRequirement): boolean => {
    try { validateGoModuleRequirement(item); return true; }
    catch (error) {
      if (error instanceof GoResolutionInvalid) return false;
      throw error;
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+\/\/.*$/, '').trim();
    if (!line || line.startsWith('//')) { plain.push(raw); continue; }
    if (requireGroup) {
      plain.push(raw);
      if (line === ')') requireGroup = false;
      continue;
    }
    if (!group && line === 'require (') {
      plain.push(raw); requireGroup = true; continue;
    }
    if (group && line === ')') { group = null; continue; }
    if (line === 'replace (' || line === 'exclude (') {
      if (group) throw new GoResolutionInvalid('nested Go directive group', 'malformed');
      group = line.startsWith('replace') ? 'replace' : 'exclude';
      continue;
    }
    const directive = group ?? (/^(replace|exclude)(?:\s|$)/.exec(line)?.[1]);
    if (!directive) { plain.push(raw); continue; }
    const clause = group ? line : line.slice(directive.length).trim();
    if (/["`]|\/\*/.test(clause)) { unsupported(`${directive} ${clause}`); continue; }
    const parts = clause.split(/\s+/);
    if (directive === 'exclude') {
      if (parts.length !== 2) throw new GoResolutionInvalid('malformed Go exclusion', 'malformed');
      const item = { path: parts[0]!, version: parts[1]! };
      if (!admitted(item)) { unsupported(`exclude ${clause}`); continue; }
      const key = `exclude ${moduleKey(item)}`;
      if (seen.has(key)) throw new GoResolutionInvalid('duplicate Go exclusion', 'duplicate');
      seen.add(key);
      directives.exclusions.push(item);
    } else {
      const arrow = parts.indexOf('=>');
      if ((arrow !== 1 && arrow !== 2) || parts.lastIndexOf('=>') !== arrow
        || (parts.length !== arrow + 2 && parts.length !== arrow + 3)) {
        throw new GoResolutionInvalid('malformed Go remote replacement', 'malformed');
      }
      if (parts.length === arrow + 2) {
        if (!/^(?:\.|\/|[A-Za-z]:)/.test(parts[arrow + 1]!)) {
          throw new GoResolutionInvalid('remote Go replacement needs a version', 'malformed');
        }
        unsupported(`replace ${clause}`); continue;
      }
      const original = { path: parts[0]!, ...(arrow === 2 ? { version: parts[1]! } : {}) };
      const source = { path: parts[arrow + 1]!, version: parts[arrow + 2]! };
      if (!pathPattern.test(original.path) || original.path.length > 200
        || (original.version !== undefined && !admitted(original as GoModuleRequirement))
        || !admitted(source)) { unsupported(`replace ${clause}`); continue; }
      const key = `replace ${original.path}\0${original.version ?? ''}`;
      if (seen.has(key)) throw new GoResolutionInvalid('duplicate Go remote replacement', 'duplicate');
      seen.add(key);
      directives.replacements.push({ original, source });
    }
    if (directives.exclusions.length > 64 || directives.replacements.length > 32) {
      throw new GoResolutionInvalid('Go main directive budget exceeded');
    }
  }
  if (group) throw new GoResolutionInvalid('unclosed Go directive group', 'malformed');
  return { parsed: parseGoModRequirements(plain.join('\n')), directives, unsupportedClauses };
}

export function capturedPrunedManifest(source: GoModuleRequirement,
  text: string): GoModuleManifest {
  const parsed = parseGoModRequirements(text);
  return { path: source.path, version: source.version, manifestText: text,
    ...(parsed.declaredModule ? { declaredModule: parsed.declaredModule } : {}),
    requirements: parsed.requirements,
    goDirective: (parsed.goDirective?.length ?? 0) <= 32 ? parsed.goDirective : null,
    unsupportedClauses: (parsed.goDirective && parsed.goDirective.length > 32
      ? [...parsed.unsupportedClauses, 'go directive exceeds profile']
      : parsed.unsupportedClauses).slice(0, 16) };
}

export function validatePrunedDirectiveManifests(input: GoMvsSnapshotRequest): void {
  const evidence = new Map(input.captureEvidence!.map(item => [moduleKey(item), item]));
  for (const release of input.releases) {
    if (typeof release.manifestText !== 'string'
      || Buffer.byteLength(release.manifestText) > 65_536) {
      throw new GoResolutionInvalid('missing bounded Go source manifest bytes', 'malformed');
    }
    if (createHash('sha256').update(release.manifestText).digest('hex')
      !== evidence.get(moduleKey(release))?.modSha256) {
      throw new GoResolutionInvalid('Go source bytes differ from capture evidence', 'changed-digest');
    }
    const parsed = capturedPrunedManifest(release, release.manifestText);
    if (release.declaredModule !== parsed.declaredModule
      || release.goDirective !== parsed.goDirective
      || JSON.stringify(release.unsupportedClauses) !== JSON.stringify(parsed.unsupportedClauses)
      || release.requirements.length !== parsed.requirements.length
      || release.requirements.some((item, index) =>
        moduleKey(item) !== moduleKey(parsed.requirements[index]!))) {
      throw new GoResolutionInvalid('Go source metadata differs from retained manifest');
    }
  }
}

/** Original coordinates drive MVS; effective source bytes drive graph expansion. */
export function solvePrunedDirectivesSnapshot(input: GoMvsSnapshotRequest): GoMvsOutcome {
  const manifests = new Map(input.releases.map(item => [moduleKey(item), item]));
  const evidence = new Map(input.captureEvidence!.map(item => [moduleKey(item), item]));
  const exclusions = new Set(input.mainDirectives!.exclusions.map(moduleKey));
  const replacements = new Map(input.mainDirectives!.replacements.map(item =>
    [`${item.original.path}\0${item.original.version ?? ''}`, item.source]));
  const sourceFor = (item: GoModuleRequirement) => replacements.get(moduleKey(item))
    ?? replacements.get(`${item.path}\0`) ?? item;
  let roots = input.roots;
  const expanded = new Set<string>();
  const maxima = new Map<string, string>();
  const missing = new Map<string, GoModuleRequirement>();
  let loaded = 0;
  let count = 0;
  const result = (status: GoMvsOutcome['status'], unsupportedClauses: string[] = []): GoMvsOutcome => ({
    status, buildList: [], missing: [], unsupportedClauses,
    loadedManifestCount: loaded, requirementCount: count,
    selectedSources: [], selectedSourceEvidence: [],
  });
  if (input.coverage.unsupportedClauses.length) {
    return result('unsupported-semantics', input.coverage.unsupportedClauses);
  }
  // cmd/go expandGraph updates upgraded explicit roots and rebuilds the pruned
  // graph. Limits count work across all passes, including repeated edge visits.
  for (;;) {
    maxima.clear();
    const scanned = new Set<string>();
    const legacyExpanded = new Set<string>();
    const queue = roots.map(requirement => ({ requirement, expand: true, legacy: false }));
    for (let offset = 0; offset < queue.length; offset++) {
      if (++count > 512) return result('budget-exhausted');
      const { requirement, expand, legacy } = queue[offset]!;
      const key = moduleKey(requirement);
      if (exclusions.has(key) || requirement.path === input.mainModule) continue;
      const current = maxima.get(requirement.path);
      if (!current || compareVersion(requirement.version, current) > 0) {
        maxima.set(requirement.path, requirement.version);
      }
      if (!expand || (scanned.has(key) && (!legacy || legacyExpanded.has(key)))) continue;
      const firstLoad = !expanded.has(key);
      expanded.add(key);
      scanned.add(key);
      if (legacy) legacyExpanded.add(key);
      if (expanded.size > 128) return result('budget-exhausted');
      const source = sourceFor(requirement);
      const release = manifests.get(moduleKey(source));
      if (!release) { missing.set(moduleKey(source), source); continue; }
      if (release.unsupportedClauses!.length || !supportedGoDirective(release.goDirective, false)) {
        return result('unsupported-semantics', (release.unsupportedClauses!.length
          ? release.unsupportedClauses!.map(clause => `${source.path}@${source.version}: ${clause}`)
          : [`${source.path}@${source.version}: go directive ${release.goDirective ?? 'absent'}`])
          .map(clause => clause.slice(0, 200)).slice(0, 16));
      }
      if (release.declaredModule !== requirement.path) {
        throw new GoResolutionInvalid('Go source manifest declares a different original module path');
      }
      if (firstLoad) loaded++;
      const follow = legacy || /^1\.16(?:\.|$)/.test(release.goDirective!);
      for (const dependency of release.requirements) {
        queue.push({ requirement: dependency, expand: follow, legacy: follow });
      }
    }
    if (!input.coverage.complete || missing.size) return {
      ...result('incomplete-source-data'), missing: [...missing.values()].sort((a, b) =>
        a.path.localeCompare(b.path) || compareVersion(a.version, b.version)),
    };
    let upgraded = false;
    roots = roots.map(root => {
      const selected = maxima.get(root.path);
      if (!exclusions.has(moduleKey(root)) && selected
        && compareVersion(selected, root.version) > 0) {
        upgraded = true;
        return { path: root.path, version: selected };
      }
      return root;
    });
    if (!upgraded) break;
  }
  const buildList = [...maxima].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, version]) => ({ path, version }));
  const sourceOwners = new Map<string, string>();
  const selectedSources: NonNullable<GoMvsOutcome['selectedSources']> = [];
  const selectedSourceEvidence = buildList.map(original => {
    const source = sourceFor(original);
    const key = moduleKey(source);
    const owner = sourceOwners.get(key);
    if (owner && owner !== original.path) {
      throw new GoResolutionInvalid('Go source is selected for multiple module paths', 'duplicate');
    }
    sourceOwners.set(key, original.path);
    if (source !== original) selectedSources.push({ original, source });
    return { original, source, expanded: expanded.has(moduleKey(original)),
      capture: evidence.get(key) ?? null };
  });
  return { ...result('solved'), buildList, selectedSources, selectedSourceEvidence };
}
