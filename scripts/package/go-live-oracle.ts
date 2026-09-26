import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { solveGoLiveGraph } from '../../services/main/src/modules/package/go-live-mvs.ts';
import { GO_LIVE_SCENARIOS } from '../../tests/qa/fixtures/go-live-scenarios.ts';
import { goLiveFiles, goLiveLoader, goNativeView, type GoNativeScenario }
  from '../../tests/qa/fixtures/go-live-snapshot.ts';

// Native Go 1.27.1 over the retained live proxy.golang.org capture, served by a
// loopback proxy with no upstream. `go list -mod=mod -m all` gives the build
// list; `go list -m -u -json all` gives each module's Retracted rationale and
// its retraction-aware Update. Both are compared with the REZICS provider-derived
// resolver over the same bytes, and the native record is retained for QA.

const nativeRecord = resolve(import.meta.dir, '../../tests/qa/fixtures/go-live-native.json');

export async function verifyGoLiveOracle(base: string, tool: string): Promise<void> {
  const directory = resolve(base, 'live');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const files = goLiveFiles();
  const unexpected = new Set<string>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request): Response {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const bytes = files.get(path);
    if (bytes === undefined) unexpected.add(path);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('not found', { status: 404 });
  } });
  const native: Record<string, GoNativeScenario> = {};
  const compared: Record<string, unknown> = {};
  const mismatches: string[] = [];
  try {
    for (const scenario of GO_LIVE_SCENARIOS) {
      const project = resolve(directory, scenario.id);
      await mkdir(project, { recursive: true });
      await writeFile(resolve(project, 'go.mod'), scenario.mainModule);
      const go = async (args: string[]) => {
        const child = Bun.spawn([tool, ...args], { cwd: project, stdout: 'pipe', stderr: 'pipe',
          env: { ...Bun.env, GOPROXY: `http://127.0.0.1:${server.port}`, GOSUMDB: 'off',
            GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', GOPATH: resolve(directory, 'gopath'),
            GOMODCACHE: resolve(directory, 'modcache'), GOCACHE: resolve(directory, 'cache'),
            GOENV: 'off', GONOPROXY: '', GOPRIVATE: '', GOWORK: 'off' } });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),
          new Response(child.stderr).text(), child.exited]);
        if (code !== 0) throw new Error(`${scenario.id}: go ${args.join(' ')}: ${stderr}`);
        return stdout;
      };
      const list = (await go(['list', '-m', 'all'])).trim().split('\n').slice(1);
      const json = await go(['list', '-m', '-u', '-json', 'all']);
      const modules = JSON.parse(`[${json.trim().replace(/\}\n\{/g, '},{')}]`) as Array<{
        Path: string; Version?: string; Main?: boolean; Retracted?: string[];
        Update?: { Version: string } }>;
      const view: GoNativeScenario = { list,
        modules: modules.filter(item => !item.Main).map(item => ({ path: item.Path,
          version: item.Version!, retracted: item.Retracted ?? null,
          update: item.Update?.Version ?? null })),
        goModChanged: (await readFile(resolve(project, 'go.mod'), 'utf8')) !== scenario.mainModule };
      native[scenario.id] = view;
      const outcome = await solveGoLiveGraph({ mainModule: scenario.mainModule, loader: goLiveLoader(files) });
      const rezics = goNativeView(outcome);
      const same = outcome.status === 'solved' && JSON.stringify(rezics.list) === JSON.stringify(view.list)
        && JSON.stringify(rezics.modules) === JSON.stringify(view.modules);
      if (!same) mismatches.push(scenario.id);
      compared[scenario.id] = { same, status: outcome.status, native: view, rezics,
        roots: outcome.roots, cost: outcome.cost, unsupported: outcome.unsupportedClauses };
    }
  } finally { await server.stop(true); }
  await writeFile(resolve(base, 'live-result.json'), JSON.stringify({ compared,
    unexpectedPaths: [...unexpected].sort() }, null, 2));
  if (mismatches.length || unexpected.size) {
    throw new Error(`native Go live comparison failed: ${[...mismatches, ...unexpected].join(', ')}; `
      + `see ${resolve(base, 'live-result.json')}`);
  }
  await writeFile(nativeRecord, `${JSON.stringify({ go: '1.27.1', scenarios: native }, null, 2)}\n`);
  console.log(`Go live oracle matched ${Object.keys(compared).length} scenarios; native record: ${nativeRecord}`);
}

if (import.meta.main) {
  const { ensureTool } = await import('./go-oracle.ts');
  await verifyGoLiveOracle(resolve('.temp/package-go-oracle'), await ensureTool());
}
