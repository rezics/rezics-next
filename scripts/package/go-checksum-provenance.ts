import { createHash } from 'node:crypto';
import { goModH1 } from '../../services/main/src/modules/package/go-proxy-capture.ts';
import { validateIncludedGoSumdbLookup, type IncludedGoSumdbLookup }
  from '../../services/main/src/modules/package/go-sumdb-lookup.ts';

export const PINNED_PSEUDO = {
  path: 'rsc.io/markdown', version: 'v0.0.0-20240306144322-0bf8f97ee8ef',
} as const;

export function pinnedPseudoProvenance(manifest: string, sums: string):
  { path: string; version: string; officialGoModH1: string; officialModuleH1: string } {
  const { path, version } = PINNED_PSEUDO;
  const requirement = manifest.split('\n').filter(line =>
    line.trim().split(/\s+/).slice(0, 2).join(' ') === `${path} ${version}`);
  if (requirement.length !== 1 || !/^\s*rsc\.io\/markdown v0\.0\.0-20240306144322-0bf8f97ee8ef(?:\s+\/\/ indirect)?\s*$/.test(requirement[0]!)) {
    throw new Error('pinned Go manifest does not retain the exact pseudo-version');
  }
  const lines = sums.split('\n');
  const checksum = (suffix: string): string => {
    const matches = lines.filter(line => line.startsWith(`${path} ${version}${suffix} `));
    if (matches.length !== 1) throw new Error('pinned Go checksum is missing or ambiguous');
    const value = matches[0]!.split(' ')[2];
    if (!/^h1:[A-Za-z0-9+/]{43}=$/.test(value ?? '')) {
      throw new Error('pinned Go checksum is invalid');
    }
    return value!;
  };
  return { path, version, officialGoModH1: checksum('/go.mod'),
    officialModuleH1: checksum('') };
}

export function verifyPseudoOracleBinding(source: ReturnType<typeof pinnedPseudoProvenance>,
  capture: { info: Uint8Array; mod: Uint8Array },
  native: { Path: string; Version: string; GoModSum?: string; Sum?: string; Error?: string },
  included: IncludedGoSumdbLookup): string {
  if (native.Error || native.Path !== source.path || native.Version !== source.version
    || native.GoModSum !== source.officialGoModH1
    || native.Sum !== source.officialModuleH1) {
    throw new Error('native Go checksum differs from pinned source');
  }
  let info: { Version?: string; Time?: string };
  try { info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.info)); }
  catch { throw new Error('captured Go version info is invalid'); }
  if (info.Version !== source.version || info.Time !== '2024-03-06T14:43:22Z') {
    throw new Error('captured Go version info differs from pinned source');
  }
  const calculated = goModH1(capture.mod);
  if (calculated !== source.officialGoModH1) {
    throw new Error('captured Go manifest checksum differs from pinned source');
  }
  validateIncludedGoSumdbLookup(included, source, calculated);
  return createHash('sha256').update(capture.mod).digest('hex');
}
