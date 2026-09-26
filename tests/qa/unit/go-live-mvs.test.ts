import { expect, test } from 'bun:test';
import { escapeGoModulePath, GoLiveInvalid, goProxyLoader, solveGoLiveGraph, type GoProxyLoader }
  from '../../../services/main/src/modules/package/go-live-mvs.ts';
import { compareGoLanguage, compareGoVersions, parseGoModFile }
  from '../../../services/main/src/modules/package/go-modfile.ts';
import { GO_LIVE_SCENARIOS } from '../fixtures/go-live-scenarios.ts';
import { goLiveFiles, goLiveLoader, goNativeRecord, goNativeView } from '../fixtures/go-live-snapshot.ts';

const native = goNativeRecord();
const scenario = (id: string) => GO_LIVE_SCENARIOS.find(item => item.id === id)!;
const encoder = new TextEncoder();

/** A synthetic proxy: `path@version` → go.mod text, `path` → @v/list lines. */
function proxy(mods: Record<string, string>, lists: Record<string, string[]>,
  requested: string[] = []): GoProxyLoader {
  return async path => {
    requested.push(path);
    const list = /^(.*)\/@v\/list$/.exec(path);
    if (list) {
      const versions = lists[list[1]!];
      return versions ? encoder.encode(versions.map(item => `${item}\n`).join('')) : null;
    }
    const mod = /^(.*)\/@v\/(.*)\.mod$/.exec(path);
    const text = mod ? mods[`${mod[1]}@${mod[2]}`] : undefined;
    return text === undefined ? null : encoder.encode(text);
  };
}
const main = (requirements: string, extra = '') =>
  `module example.com/main\n\ngo 1.21\n${extra}\nrequire (\n${requirements}\n)\n`;

test('PKG05: provider-derived pruned MVS over the live proxy.golang.org capture equals native Go 1.27.1', async () => {
  for (const item of GO_LIVE_SCENARIOS) {
    const requested: string[] = [];
    const outcome = await solveGoLiveGraph({ mainModule: item.mainModule,
      loader: goLiveLoader(goLiveFiles(), requested) });
    expect(outcome.status).toBe('solved');
    const { goModChanged: _changed, ...expected } = native[item.id]!;
    expect(goNativeView(outcome)).toEqual(expected);
    expect(new Set(requested).size).toBe(requested.length);
  }
  const retract = await solveGoLiveGraph({ mainModule: scenario('retract-major-unpruned').mainModule,
    loader: goLiveLoader() });
  const module = (path: string) => retract.buildList.find(item => item.path === path)!;
  // Retracted roots stay selected: MVS never silently replaces a required version.
  expect(module('github.com/klauspost/compress')).toMatchObject({ version: 'v1.14.2',
    retracted: ['retracted by module author'], update: 'v1.20.1' });
  expect(module('google.golang.org/grpc')).toMatchObject({ version: 'v1.74.0',
    retracted: ['v1.74.0 was published prematurely with known issues.'] });
  expect(module('github.com/go-chi/chi/v5').version).toBe('v5.0.12');
  expect(module('gopkg.in/yaml.v3').version).toBe('v3.0.1');
  // logrus v1.8.1 declares go 1.13, so its branch is expanded transitively.
  expect(retract.loaded).toContain('github.com/stretchr/testify@v1.2.2');
  expect(retract.cost.graphVisits).toBeLessThan(retract.buildList.length / 3);
  expect(retract.ignoredClauses.some(item => item.includes(': replace '))).toBe(true);
  const stabilized = await solveGoLiveGraph({ mainModule: scenario('root-stabilization').mainModule,
    loader: goLiveLoader() });
  expect(stabilized.cost.graphRounds).toBe(2);
  expect(stabilized.roots.find(item => item.path === 'golang.org/x/net')?.version).not.toBe('v0.1.0');
  expect(stabilized.loaded).toContain('golang.org/x/net@v0.1.0');
});

test('PKG05: the go.mod reader keeps live directives and ignores dependency replace/exclude as Go does', () => {
  const text = `// Module comment
module example.com/m

go 1.23.0

toolchain go1.24.2

godebug (
	default=go1.21
	panicnil=1
)

tool example.com/m/cmd/gen

ignore ./testdata

require (
	example.com/a v1.2.3 // indirect
	"example.com/quoted" v0.1.0
)

exclude example.com/a v1.2.2
replace example.com/a v1.2.3 => example.com/fork v1.0.0
replace example.com/local => ../local

// Published with a broken API.
retract v1.0.1

retract (
	// Block entry rationale.
	[v1.1.0, v1.1.9]

	v1.2.0 // Suffix rationale.
)
`;
  const strict = parseGoModFile(text, 'strict');
  expect(strict.errors).toEqual([]);
  expect(strict).toMatchObject({ module: 'example.com/m', go: '1.23.0', toolchain: 'go1.24.2',
    godebug: [{ key: 'default', value: 'go1.21' }, { key: 'panicnil', value: '1' }],
    tool: ['example.com/m/cmd/gen'], ignore: ['./testdata'],
    require: [{ path: 'example.com/a', version: 'v1.2.3', indirect: true },
      { path: 'example.com/quoted', version: 'v0.1.0', indirect: false }],
    exclude: [{ path: 'example.com/a', version: 'v1.2.2' }],
    retract: [{ low: 'v1.0.1', high: 'v1.0.1', rationale: 'Published with a broken API.' },
      { low: 'v1.1.0', high: 'v1.1.9', rationale: 'Block entry rationale.' },
      { low: 'v1.2.0', high: 'v1.2.0', rationale: 'Suffix rationale.' }] });
  expect(strict.replace).toHaveLength(2);
  const lax = parseGoModFile(`${text}\nfuture directive\nreplace x@v1 => ../\n`, 'lax');
  expect([lax.errors, lax.exclude, lax.replace, lax.toolchain, lax.godebug]).toEqual([[], [], [], null, []]);
  expect(lax.ignored.filter(item => /^(?:replace|exclude|future) /.test(item))).toHaveLength(5);
  expect(lax.retract).toEqual(strict.retract);
  expect(parseGoModFile('module m\nfuture directive\n', 'strict').errors)
    .toEqual(['line 2: unknown directive future']);
  expect(parseGoModFile('module m\nretract [v1.2.0, v1.0.0]\n', 'lax').errors).toEqual(['line 2: invalid retract']);
  expect(parseGoModFile('module m\nrequire (\n', 'lax').errors).toEqual(['unclosed require block']);
  expect(['v1.2.3', 'v1.10.0', 'v2.0.0+incompatible', 'v1.2.3-pre.2', 'v1.2.3-pre.10',
    'v0.0.0-20200101000000-abcdefabcdef'].sort(compareGoVersions)).toEqual(['v0.0.0-20200101000000-abcdefabcdef',
    'v1.2.3-pre.2', 'v1.2.3-pre.10', 'v1.2.3', 'v1.10.0', 'v2.0.0+incompatible']);
  expect(['1.21.0', '1.21rc1', '1.21', '1.21beta1', '1.9'].sort(compareGoLanguage))
    .toEqual(['1.9', '1.21', '1.21beta1', '1.21rc1', '1.21.0']);
  expect(escapeGoModulePath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml');
});

test('PKG05: retraction comes from the latest go.mod and upgrades skip retracted versions', async () => {
  const mods = {
    'example.com/r@v1.1.0': 'module example.com/r\n\ngo 1.21\n\nretract v1.0.0 // stale rationale ignored\n',
    'example.com/r@v1.3.0': 'module example.com/r\n\ngo 1.21\n\n// Broken release.\nretract [v1.1.0, v1.3.0]\n',
    'example.com/u@v0.1.0': 'module example.com/u\n\ngo 1.21\n',
  };
  const lists = { 'example.com/r': ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0-rc.1'],
    'example.com/u': ['v0.1.0', 'v0.2.0-beta.1'] };
  const outcome = await solveGoLiveGraph({ mainModule: main('\texample.com/r v1.1.0\n\texample.com/u v0.1.0'),
    loader: proxy(mods, lists) });
  expect(outcome.status).toBe('solved');
  // Latest release v1.3.0 retracts itself: the update skips every retracted
  // release and, with no allowed release above, falls to nothing newer.
  expect(outcome.buildList).toEqual([
    { path: 'example.com/r', version: 'v1.1.0', goVersion: '1.21', retracted: ['Broken release.'],
      update: null, latest: 'v1.3.0' },
    { path: 'example.com/u', version: 'v0.1.0', goVersion: '1.21', retracted: null, update: null,
      latest: 'v0.1.0' }]);
  // Only the latest go.mod speaks: v1.1.0's own retraction of v1.0.0 is ignored.
  const older = await solveGoLiveGraph({ mainModule: main('\texample.com/r v1.0.0'),
    loader: proxy({ ...mods, 'example.com/r@v1.0.0': 'module example.com/r\n\ngo 1.21\n' }, lists) });
  expect(older.buildList[0]).toMatchObject({ version: 'v1.0.0', retracted: null, update: null });
  const skip = await solveGoLiveGraph({ mainModule: main('\texample.com/s v1.0.0'), loader: proxy({
    'example.com/s@v1.0.0': 'module example.com/s\n\ngo 1.21\n',
    'example.com/s@v1.2.0': 'module example.com/s\n\ngo 1.21\n\nretract v1.2.0 // Tagged by mistake.\n',
  }, { 'example.com/s': ['v1.0.0', 'v1.1.0', 'v1.2.0'] }) });
  expect(skip.buildList[0]).toMatchObject({ version: 'v1.0.0', retracted: null, update: 'v1.1.0',
    latest: 'v1.2.0' });
});

test('PKG05: missing go.mod or version list is incomplete, never an empty requirement set or unretracted', async () => {
  const mods = { 'example.com/a@v1.0.0': 'module example.com/a\n\ngo 1.16\n\nrequire example.com/b v1.0.0\n',
    'example.com/b@v1.0.0': 'module example.com/b\n\ngo 1.21\n' };
  const lists = { 'example.com/a': ['v1.0.0'], 'example.com/b': ['v1.0.0'] };
  const solved = await solveGoLiveGraph({ mainModule: main('\texample.com/a v1.0.0'), loader: proxy(mods, lists) });
  expect(solved.buildList.map(item => `${item.path}@${item.version}`)).toEqual(['example.com/a@v1.0.0', 'example.com/b@v1.0.0']);
  const { 'example.com/b@v1.0.0': _b, ...withoutB } = mods;
  const missingMod = await solveGoLiveGraph({ mainModule: main('\texample.com/a v1.0.0'), loader: proxy(withoutB, lists) });
  expect([missingMod.status, missingMod.missing, missingMod.buildList])
    .toEqual(['incomplete-source-data', ['example.com/b/@v/v1.0.0.mod'], []]);
  const missingList = await solveGoLiveGraph({ mainModule: main('\texample.com/a v1.0.0'),
    loader: proxy(mods, { 'example.com/a': ['v1.0.0'] }) });
  expect([missingList.status, missingList.missing]).toEqual(['incomplete-source-data', ['example.com/b/@v/list']]);
  const live = goLiveFiles();
  live.set('github.com/sirupsen/logrus/@v/v1.8.1.mod', null);
  const liveMissing = await solveGoLiveGraph({ mainModule: scenario('retract-major-unpruned').mainModule,
    loader: goLiveLoader(live) });
  expect([liveMissing.status, liveMissing.missing]).toEqual(['incomplete-source-data',
    ['github.com/sirupsen/logrus/@v/v1.8.1.mod']]);
});

test('PKG05: unsupported directives and toolchain requirements are explicit, not guessed', async () => {
  const mods = { 'example.com/new@v1.0.0': 'module example.com/new\n\ngo 1.99\n',
    'example.com/wrong@v1.0.0': 'module example.com/other\n\ngo 1.21\n' };
  const lists = { 'example.com/new': ['v1.0.0'], 'example.com/wrong': ['v1.0.0'] };
  const newer = await solveGoLiveGraph({ mainModule: main('\texample.com/new v1.0.0'), loader: proxy(mods, lists) });
  expect([newer.status, newer.unsupportedClauses]).toEqual(['unsupported-semantics',
    ['example.com/new@v1.0.0: requires go 1.99 beyond pinned go1.27.1']]);
  const wrong = await solveGoLiveGraph({ mainModule: main('\texample.com/wrong v1.0.0'), loader: proxy(mods, lists) });
  expect(wrong.unsupportedClauses).toEqual(['example.com/wrong@v1.0.0: go.mod declares example.com/other']);
  const replaced = await solveGoLiveGraph({ mainModule: main('\texample.com/new v1.0.0',
    'replace example.com/new => example.com/fork v1.0.0\n'), loader: proxy(mods, lists) });
  expect(replaced.status).toBe('unsupported-semantics');
  const legacy = await solveGoLiveGraph({ mainModule: 'module example.com/main\n\ngo 1.16\n', loader: proxy({}, {}) });
  expect(legacy.status).toBe('unsupported-semantics');
  await expect(solveGoLiveGraph({ mainModule: 'module example.com/main\nfuture x\n', loader: proxy({}, {}) }))
    .rejects.toBeInstanceOf(GoLiveInvalid);
  expect(() => goProxyLoader('http://proxy.golang.org/')).toThrow(GoLiveInvalid);
  await expect(goProxyLoader(undefined, (async () => new Response('')) as unknown as typeof fetch)('../etc/passwd'))
    .rejects.toBeInstanceOf(GoLiveInvalid);
});

test('PKG05/PKG13: fetch budgets and cancellation stop loading with truthful outcomes', async () => {
  const mainModule = scenario('retract-major-unpruned').mainModule;
  const budget = await solveGoLiveGraph({ mainModule, loader: goLiveLoader(), limits: { maxFetches: 8 } });
  expect([budget.status, budget.budget, budget.buildList]).toEqual(['budget-exhausted',
    { kind: 'fetches', limit: 8, used: 9 }, []]);
  const controller = new AbortController();
  let loads = 0;
  const files = goLiveFiles();
  const cancelled = await solveGoLiveGraph({ mainModule, signal: controller.signal,
    loader: async path => { if (++loads === 3) controller.abort(); return files.get(path) ?? null; } });
  expect([cancelled.status, cancelled.buildList, cancelled.cost.fetches]).toEqual(['cancelled', [], 3]);
});
