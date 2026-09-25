import { GoResolutionInvalid, type GoModuleRequirement,
  validateGoModuleRequirement } from './go-mvs.ts';

export interface ParsedGoMod {
  profile: 'go-mod-requirements-v1';
  status: 'parsed' | 'unsupported-syntax';
  declaredModule: string | null;
  goDirective: string | null;
  requirements: GoModuleRequirement[];
  unsupportedClauses: string[];
  compatibleWithUnprunedGo116: boolean;
}

const MODULE = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const DIRECTIVE = /^go ([1-9][0-9]*\.[0-9]+(?:\.[0-9]+)?)$/;

/** Parse only the line-oriented Go module subset needed by the first MVS profile. */
export function parseGoModRequirements(text: string, expectedPath?: string): ParsedGoMod {
  let declaredModule: string | null = null;
  let goDirective: string | null = null;
  const requirements: GoModuleRequirement[] = [];
  const unsupportedClauses: string[] = [];
  const seen = new Set<string>();
  let group = false;
  const unsupported = (line: string) => {
    if (unsupportedClauses.length < 16) unsupportedClauses.push(line.slice(0, 200));
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+\/\/.*$/, '').trim();
    if (!line || line.startsWith('//')) continue;
    if (line.includes('"') || line.includes('`') || line.includes('/*')) {
      unsupported(line);
      continue;
    }
    if (group) {
      if (line === ')') { group = false; continue; }
      const parts = line.split(/\s+/);
      if (parts.length !== 2) { unsupported(line); continue; }
      const requirement = { path: parts[0]!, version: parts[1]! };
      try { validateGoModuleRequirement(requirement); }
      catch (error) {
        if (error instanceof GoResolutionInvalid) { unsupported(line); continue; }
        throw error;
      }
      if (seen.has(requirement.path)) { unsupported(line); continue; }
      seen.add(requirement.path);
      requirements.push(requirement);
      continue;
    }
    if (line.startsWith('module ')) {
      const path = line.slice('module '.length).trim();
      if (declaredModule !== null || !MODULE.test(path) || path.length > 200) {
        unsupported(line);
      } else declaredModule = path;
      continue;
    }
    if (line.startsWith('go ')) {
      const match = DIRECTIVE.exec(line);
      if (goDirective !== null || !match) unsupported(line);
      else goDirective = match[1]!;
      continue;
    }
    if (line === 'require (') { group = true; continue; }
    if (line.startsWith('require ')) {
      const parts = line.slice('require '.length).trim().split(/\s+/);
      if (parts.length !== 2) { unsupported(line); continue; }
      const requirement = { path: parts[0]!, version: parts[1]! };
      try { validateGoModuleRequirement(requirement); }
      catch (error) {
        if (error instanceof GoResolutionInvalid) { unsupported(line); continue; }
        throw error;
      }
      if (seen.has(requirement.path)) { unsupported(line); continue; }
      seen.add(requirement.path);
      requirements.push(requirement);
      continue;
    }
    unsupported(line);
  }
  if (group) unsupported('unclosed require group');
  if (declaredModule === null) unsupported('missing module directive');
  if (expectedPath && declaredModule !== expectedPath) {
    unsupported(`module identity differs from ${expectedPath}`);
  }
  if (requirements.length > 64) unsupported('requirement count exceeds profile');
  const status = unsupportedClauses.length ? 'unsupported-syntax' : 'parsed';
  return { profile: 'go-mod-requirements-v1', status, declaredModule,
    goDirective, requirements: status === 'parsed' ? requirements : [],
    unsupportedClauses,
    compatibleWithUnprunedGo116: status === 'parsed' && goDirective === '1.16' };
}
