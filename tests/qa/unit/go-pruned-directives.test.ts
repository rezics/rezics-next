import { expect, test } from 'bun:test';
import { GoResolutionInvalid, solveGoMvsSnapshot }
  from '../../../services/main/src/modules/package/go-mvs.ts';
import { parseGoModRequirements }
  from '../../../services/main/src/modules/package/go-mod-parser.ts';
import { parseGoRemoteMainManifest }
  from '../../../services/main/src/modules/package/go-pruned-directives.ts';
import { goManifest, goPrunedDirectivesFixture, goPrunedMain, goPrunedSnapshot,
  goPrunedSources, goRequirement as req, goSha }
  from '../fixtures/go-pruned-directives.ts';

test('PKG05/PKG12: main remote rules preserve pruned selection and exact source provenance', () => {
  const request = goPrunedDirectivesFixture();
  const outcome = solveGoMvsSnapshot(request);
  expect(outcome).toMatchObject({ status: 'solved', loadedManifestCount: 5,
    buildList: [req('example.com/a'), req('example.com/b'), req('example.com/bridge'),
      req('example.com/compat/v2', 'v2.0.0'), req('example.com/deep'),
      req('example.com/lazy/v2', 'v2.0.0')],
    selectedSources: [
      { original: req('example.com/a'), source: req('example.com/fork/exact') },
      { original: req('example.com/lazy/v2', 'v2.0.0'),
        source: req('example.com/fork/lazy/v2', 'v2.1.0') },
    ] });
  expect(outcome.selectedSourceEvidence![0]).toEqual({ original: req('example.com/a'),
    source: req('example.com/fork/exact'), expanded: true, capture: request.captureEvidence![1] });
  expect(outcome.selectedSourceEvidence!.at(-1)).toEqual({
    original: req('example.com/lazy/v2', 'v2.0.0'),
    source: req('example.com/fork/lazy/v2', 'v2.1.0'), expanded: false, capture: null });
  const swapped = goPrunedMain.replace(
    ' example.com/a => example.com/fork/a v1.0.0\n example.com/a v1.0.0 => example.com/fork/exact v1.0.0',
    ' example.com/a v1.0.0 => example.com/fork/exact v1.0.0\n example.com/a => example.com/fork/a v1.0.0');
  expect(solveGoMvsSnapshot(goPrunedSnapshot(swapped, goPrunedSources))).toEqual(outcome);
  const wildcard = goPrunedMain.replace(' example.com/a v1.0.0 => example.com/fork/exact v1.0.0\n', '');
  expect(solveGoMvsSnapshot(goPrunedSnapshot(wildcard, goPrunedSources))).toMatchObject({
    status: 'solved', selectedSources: [
      { original: req('example.com/a'), source: req('example.com/fork/a') }],
    buildList: expect.arrayContaining([req('example.com/wild')]) });
  // Capture parser receipts retain their old meaning for a fork declaring the original path.
  expect(parseGoModRequirements(goPrunedSources[1]!.text, 'example.com/fork/exact').status)
    .toBe('unsupported-syntax');
  expect(parseGoModRequirements(goPrunedMain).status).toBe('unsupported-syntax');
});

test('PKG05/PKG13: missing replacement never falls back and exclusions suppress expansion', () => {
  const originals = [{ ...req('example.com/a'), text: goManifest('example.com/a') }];
  const missing = goPrunedSnapshot(goPrunedMain,
    [...goPrunedSources.filter(source => source.path !== 'example.com/fork/exact'), ...originals]);
  expect(solveGoMvsSnapshot(missing)).toMatchObject({ status: 'incomplete-source-data',
    buildList: [], missing: [req('example.com/fork/exact')], selectedSourceEvidence: [] });
  const excludedMain = goPrunedMain.replace('exclude (', 'require example.com/excluded v1.0.0\nexclude (');
  expect(solveGoMvsSnapshot(goPrunedSnapshot(excludedMain, goPrunedSources)))
    .toMatchObject({ status: 'solved', missing: [] });
  const requiredLazy = goPrunedMain.replace('go 1.17',
    'go 1.17\nrequire example.com/lazy/v2 v2.0.0');
  expect(solveGoMvsSnapshot(goPrunedSnapshot(requiredLazy, goPrunedSources)))
    .toMatchObject({ status: 'incomplete-source-data', missing: [
      req('example.com/fork/lazy/v2', 'v2.1.0')] });
  const legacySources = goPrunedSources.map(source => source.path === 'example.com/fork/exact'
    ? { ...source, text: source.text.replace('go 1.17', 'go 1.16') } : source);
  expect(solveGoMvsSnapshot(goPrunedSnapshot(goPrunedMain, legacySources)))
    .toMatchObject({ status: 'incomplete-source-data', missing: [
      req('example.com/fork/lazy/v2', 'v2.1.0')] });
});

test('PKG05/PKG13: unexpanded captured source stays available without being interpreted', () => {
  const sources = [...goPrunedSources, { ...req('example.com/fork/lazy/v2', 'v2.1.0'),
    text: 'module example.com/lazy/v2\n\ngo 1.28\nfuture unknown\n' }];
  const request = goPrunedSnapshot(goPrunedMain, sources);
  expect(solveGoMvsSnapshot(request)).toMatchObject({ status: 'solved',
    selectedSourceEvidence: expect.arrayContaining([{
      original: req('example.com/lazy/v2', 'v2.0.0'),
      source: req('example.com/fork/lazy/v2', 'v2.1.0'), expanded: false,
      capture: request.captureEvidence!.at(-1),
    }]) });
  const main = goPrunedMain.replace('go 1.17', 'go 1.17\nrequire example.com/lazy/v2 v2.0.0');
  expect(solveGoMvsSnapshot(goPrunedSnapshot(main, sources))).toMatchObject({
    status: 'unsupported-semantics', buildList: [],
    unsupportedClauses: [expect.stringContaining('future unknown')] });
});

test('PKG05/PKG13: wrong manifest identity, changed bytes and forged parsed metadata are refused', () => {
  const changed = goPrunedSources.map(source => source.path === 'example.com/fork/exact'
    ? { ...source, text: source.text.replace('module example.com/a', 'module example.com/wrong') } : source);
  expect(() => solveGoMvsSnapshot(goPrunedSnapshot(goPrunedMain, changed)))
    .toThrow('different original module path');
  const request = goPrunedDirectivesFixture();
  request.releases[1]!.manifestText += '\n';
  expect(() => solveGoMvsSnapshot(request)).toThrow('differ from capture evidence');
  const forged = goPrunedDirectivesFixture();
  forged.releases[1]!.requirements = [];
  expect(() => solveGoMvsSnapshot(forged)).toThrow('metadata differs');
  const rule = goPrunedDirectivesFixture();
  rule.mainDirectives!.replacements[0]!.source.path = 'example.com/forged';
  expect(() => solveGoMvsSnapshot(rule)).toThrow('directives differ');
  const digest = goPrunedDirectivesFixture();
  digest.mainManifest!.rawSha256 = goSha('different');
  expect(() => solveGoMvsSnapshot(digest)).toThrow('invalid retained');
});

test('PKG05/PKG13: unsupported, malformed and duplicate remote directives are distinct', () => {
  for (const clause of ['replace example.com/a => ./local', 'toolchain go1.27.1',
    'replace example.com/a => example.com/fork/a v1.0.0-beta']) {
    const request = goPrunedSnapshot(`${goManifest('example.com/main')}\n${clause}\n`, []);
    expect(solveGoMvsSnapshot(request)).toMatchObject({ status: 'unsupported-semantics', buildList: [] });
  }
  for (const clause of ['replace example.com/a =>', 'exclude example.com/a', 'replace (\n']) {
    try { parseGoRemoteMainManifest(`${goManifest('example.com/main')}\n${clause}\n`); throw new Error('accepted'); }
    catch (error) { expect(error).toBeInstanceOf(GoResolutionInvalid);
      expect((error as GoResolutionInvalid).kind).toBe('malformed'); }
  }
  for (const clause of ['replace example.com/a => example.com/fork/a v1.0.0',
    'exclude example.com/a v1.0.0']) {
    try { parseGoRemoteMainManifest(`${goManifest('example.com/main')}\n${clause}\n${clause}\n`); throw new Error('accepted'); }
    catch (error) { expect(error).toBeInstanceOf(GoResolutionInvalid);
      expect((error as GoResolutionInvalid).kind).toBe('duplicate'); }
  }
});

test('PKG05/PKG13: selected replacement source collisions are refused even when pruned', () => {
  const main = `${goManifest('example.com/main', '1.17', [req('example.com/root')])}
replace example.com/x => example.com/shared v1.0.0
replace example.com/y => example.com/shared v1.0.0
`;
  expect(() => solveGoMvsSnapshot(goPrunedSnapshot(main, [{ ...req('example.com/root'),
    text: goManifest('example.com/root', '1.17', [req('example.com/x'), req('example.com/y')]) }])))
    .toThrow('multiple module paths');
});

test('PKG05/PKG12: upgraded explicit roots reload their replacement and discard old pruned edges', () => {
  const main = goPrunedMain.replace(' example.com/a v1.0.0 =>', ' example.com/a v1.1.0 =>');
  const sources = goPrunedSources.map(source => source.path === 'example.com/b'
    ? { ...source, text: goManifest('example.com/b', '1.17', [req('example.com/a', 'v1.1.0')]) }
    : source);
  expect(solveGoMvsSnapshot(goPrunedSnapshot(main, sources))).toMatchObject({
    status: 'solved', buildList: [req('example.com/a', 'v1.1.0'), req('example.com/b'),
      req('example.com/compat/v2', 'v2.0.0'), req('example.com/lazy/v2', 'v2.0.0')],
    selectedSources: [
      { original: req('example.com/a', 'v1.1.0'), source: req('example.com/fork/exact') },
      { original: req('example.com/lazy/v2', 'v2.0.0'), source: req('example.com/fork/lazy/v2', 'v2.1.0') },
    ] });
});

test('PKG05/PKG13: combined pruning and directives retain requirement and manifest budgets', () => {
  for (const width of [2, 4, 9]) {
    const roots = Array.from({ length: width }, (_, index) => req(`example.com/root${index}`));
    const sources = roots.map((root, index) => ({ ...root, text: goManifest(root.path, '1.17',
      Array.from({ length: 64 }, (_, child) => req(`example.com/dependency${index}x${child}`))) }));
    const outcome = solveGoMvsSnapshot(goPrunedSnapshot(goManifest('example.com/main', '1.17', roots), sources));
    expect(outcome.loadedManifestCount).toBe(width);
    expect(outcome.requirementCount).toBe(Math.min(513, width * 65));
    expect(outcome.status).toBe(width === 9 ? 'budget-exhausted' : 'solved');
  }
  const sources = Array.from({ length: 128 }, (_, index) => ({ ...req(`example.com/m${index}`),
    text: goManifest(`example.com/m${index}`, '1.16', [req(`example.com/m${index + 1}`)]) }));
  expect(solveGoMvsSnapshot(goPrunedSnapshot(goManifest('example.com/main', '1.17',
    [req('example.com/m0')]), sources))).toMatchObject({ status: 'budget-exhausted',
    buildList: [], loadedManifestCount: 128, requirementCount: 129 });
});
