import { createHash } from 'node:crypto';
import type { GoModuleRequirement, GoMvsSnapshotRequest }
  from '../../../services/main/src/modules/package/go-mvs.ts';
import { capturedPrunedManifest, parseGoRemoteMainManifest }
  from '../../../services/main/src/modules/package/go-pruned-directives.ts';

export const goSha = (text: string) => createHash('sha256').update(text).digest('hex');
export const goRequirement = (path: string, version = 'v1.0.0') => ({ path, version });
export const goManifest = (path: string, go = '1.17',
  requirements: GoModuleRequirement[] = []) => `module ${path}\n\ngo ${go}\n${
  requirements.map(item => `require ${item.path} ${item.version}\n`).join('')}`;

export function goPrunedSnapshot(text: string,
  sources: Array<GoModuleRequirement & { text: string }>): GoMvsSnapshotRequest {
  const main = parseGoRemoteMainManifest(text);
  return {
    profile: 'go-mvs-captured-pruned-main-directives-v6',
    mainModule: main.parsed.declaredModule!, goDirective: main.parsed.goDirective!,
    mainManifest: { text, rawSha256: goSha(text) },
    coverage: { complete: true, unsupportedClauses: [
      ...main.parsed.unsupportedClauses, ...main.unsupportedClauses] },
    roots: main.parsed.requirements, mainDirectives: main.directives,
    releases: sources.map(source => capturedPrunedManifest(source, source.text)),
    captureEvidence: sources.map((source, index) => ({
      captureId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      path: source.path, version: source.version,
      listSha256: goSha(`${source.version}\n`),
      infoSha256: goSha(JSON.stringify({ Version: source.version, Time: '2020-01-01T00:00:00Z' })),
      modSha256: goSha(source.text),
    })),
  };
}

export const goPrunedMain = `${goManifest('example.com/main', '1.17', [
  goRequirement('example.com/a'), goRequirement('example.com/b'),
  goRequirement('example.com/compat/v2', 'v2.0.0')])}
exclude (
 example.com/excluded v1.0.0
)
replace (
 example.com/a => example.com/fork/a v1.0.0
 example.com/a v1.0.0 => example.com/fork/exact v1.0.0
 example.com/lazy/v2 => example.com/fork/lazy/v2 v2.1.0
 example.com/excluded v1.0.0 => example.com/never v1.0.0
)
`;
export const goPrunedSources = [
  { ...goRequirement('example.com/fork/a'), text: goManifest('example.com/a', '1.17',
    [goRequirement('example.com/wild')]) },
  { ...goRequirement('example.com/fork/exact'), text: goManifest('example.com/a', '1.17', [
    goRequirement('example.com/lazy/v2', 'v2.0.0'), goRequirement('example.com/excluded')]) },
  { ...goRequirement('example.com/b'), text: goManifest('example.com/b', '1.16',
    [goRequirement('example.com/bridge')]) },
  { ...goRequirement('example.com/bridge'), text: goManifest('example.com/bridge', '1.17',
    [goRequirement('example.com/deep')]) },
  { ...goRequirement('example.com/deep'), text: goManifest('example.com/deep') },
  { ...goRequirement('example.com/compat/v2', 'v2.0.0'), text: goManifest('example.com/compat/v2') },
];
export const goPrunedDirectivesFixture = () => goPrunedSnapshot(goPrunedMain, goPrunedSources);

/** Fixed fixture proxy responses; no production provider is contacted. */
export function goPrunedFixtureResponse(value: string): Response | null {
  const [path, file] = new URL(value).pathname.slice(1).split('/@v/');
  const source = goPrunedSources.find(item => item.path === path);
  if (!source) return null;
  if (file === 'list') return new Response(`${source.version}\n`);
  if (file === `${source.version}.info`) return new Response(JSON.stringify({
    Version: source.version, Time: '2020-01-01T00:00:00Z' }));
  if (file === `${source.version}.mod`) return new Response(source.text);
  return new Response('', { status: 404 });
}

export function goPrunedDirectiveScenarios(): Array<{ name: string; request: GoMvsSnapshotRequest }> {
  const withoutWildcard = goPrunedMain.replace(' example.com/a => example.com/fork/a v1.0.0\n', '');
  const withoutExact = goPrunedMain.replace(' example.com/a v1.0.0 => example.com/fork/exact v1.0.0\n', '');
  const legacySources = goPrunedSources.map(source => source.path === 'example.com/fork/exact'
    ? { ...source, text: source.text.replace('go 1.17', 'go 1.16') } : source);
  legacySources.push({ ...goRequirement('example.com/fork/lazy/v2', 'v2.1.0'),
    text: goManifest('example.com/lazy/v2', '1.17', [goRequirement('example.com/deep')]) });
  // A separate valid main requires a lower root version; b raises that root path.
  const upgradedMain = goPrunedMain.replace(' example.com/a v1.0.0 =>', ' example.com/a v1.1.0 =>');
  const upgradedSources = goPrunedSources.map(source => source.path === 'example.com/b'
    ? { ...source, text: goManifest('example.com/b', '1.17',
      [goRequirement('example.com/a', 'v1.1.0')]) } : source);
  return [
    { name: 'pruned-main-exact', request: goPrunedSnapshot(withoutWildcard, goPrunedSources) },
    { name: 'pruned-main-path-wide', request: goPrunedSnapshot(withoutExact, goPrunedSources) },
    { name: 'pruned-main-precedence-lazy', request: goPrunedDirectivesFixture() },
    { name: 'pruned-main-legacy-replacement', request: goPrunedSnapshot(goPrunedMain, legacySources) },
    { name: 'pruned-main-excluded-root', request: goPrunedSnapshot(
      goPrunedMain.replace('exclude (', 'require example.com/excluded v1.0.0\nexclude ('), goPrunedSources) },
    { name: 'pruned-main-upgraded-root', request: goPrunedSnapshot(upgradedMain, upgradedSources) },
  ];
}
