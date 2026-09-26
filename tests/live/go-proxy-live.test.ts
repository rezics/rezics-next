import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GO_PROXY_ORIGIN, goProxyLoader, solveGoLiveGraph }
  from '../../services/main/src/modules/package/go-live-mvs.ts';
import { GO_LIVE_SCENARIOS } from '../qa/fixtures/go-live-scenarios.ts';

// One live proxy.golang.org observation. REZICS's Main loader resolves each
// scenario directly against the proxy; native Go 1.27.1 then runs the same main
// modules through a loopback proxy that forwards to proxy.golang.org and records
// every response, so the retained capture also serves the native comparison.
// `GO_LIVE_RECORD=1` replaces the QA fixture; otherwise output goes to `.artifacts/`.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('PKG05: live proxy.golang.org capture serves the Main loader and native Go', async () => {
  const recorded = new Map<string, Uint8Array | null>();
  const live = goProxyLoader();
  const recording = async (path: string, signal?: AbortSignal) => {
    if (!recorded.has(path)) recorded.set(path, await live(path, signal));
    return recorded.get(path)!;
  };
  const outcomes: Record<string, unknown> = {};
  for (const scenario of GO_LIVE_SCENARIOS) {
    const outcome = await solveGoLiveGraph({ mainModule: scenario.mainModule, loader: recording });
    expect([outcome.status, outcome.missing, outcome.unsupportedClauses]).toEqual(['solved', [], []]);
    outcomes[scenario.id] = { modules: outcome.buildList.length, cost: outcome.cost,
      retracted: outcome.buildList.filter(item => item.retracted).map(item => `${item.path}@${item.version}`) };
  }
  const { ensureTool } = await import('../../scripts/package/go-oracle.ts');
  const tool = await ensureTool();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const bytes = await recording(path);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('not found', { status: 404 });
  } });
  const work = mkdtempSync(join(tmpdir(), 'rezics-go-live-'));
  try {
    for (const scenario of GO_LIVE_SCENARIOS) {
      const project = join(work, scenario.id);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'go.mod'), scenario.mainModule);
      for (const args of [['list', '-m', 'all'], ['list', '-m', '-u', '-json', 'all']]) {
        const child = Bun.spawn([tool, ...args], { cwd: project, stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env,
          GOPROXY: `http://127.0.0.1:${server.port}`, GOSUMDB: 'off', GOFLAGS: '-mod=mod',
          GOTOOLCHAIN: 'local', GOPATH: join(work, 'gopath'), GOMODCACHE: join(work, 'modcache'),
          GOCACHE: join(work, 'cache'), GOENV: 'off', GONOPROXY: '', GOPRIVATE: '', GOWORK: 'off' } });
        const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        await new Response(child.stdout).text();
        if (code !== 0) throw new Error(`${scenario.id}: go ${args.join(' ')}: ${stderr}`);
      }
    }
  } finally {
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
  const output = Bun.env.GO_LIVE_RECORD === '1' ? resolve(import.meta.dir, '../qa/fixtures/go-live-proxy')
    : resolve(import.meta.dir, '../../.artifacts/go-live', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(output, { recursive: true });
  const entries = [...recorded].sort(([a], [b]) => a < b ? -1 : 1).map(([path, bytes]) => ({
    path, present: bytes !== null, bytes: bytes?.length ?? 0, sha256: bytes ? sha(bytes) : null }));
  writeFileSync(join(output, 'bodies.json.gz'), Bun.gzipSync(Buffer.from(JSON.stringify(Object.fromEntries(
    [...recorded].filter(([, bytes]) => bytes).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, bytes]) => [path, Buffer.from(bytes!).toString('base64')])))), { level: 9 }));
  writeFileSync(join(output, 'capture.json'), `${JSON.stringify({ profile: 'go-proxy-capture-set-v1',
    origin: GO_PROXY_ORIGIN, capturedAt: new Date().toISOString(), entries }, null, 2)}\n`);
  console.info(`proxy.golang.org capture: ${entries.length} paths; ${output}\n${JSON.stringify(outcomes)}`);
}, 900_000);
