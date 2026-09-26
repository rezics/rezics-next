import { expect, test } from 'bun:test';
import { GO_LIVE_LIMITS, goProxyResponseLoader, solveGoLiveGraph, type GoProxyLoader }
  from '../../services/main/src/modules/package/go-live-mvs.ts';
import { GO_PROXY_CAPTURE_BYTES, goProxyCaptureRequest, goProxyRunAdapter }
  from '../../services/main/src/modules/package/go-refresh.ts';
import { parseGoModFile } from '../../services/main/src/modules/package/go-modfile.ts';
import { GO_LIVE_SCENARIOS } from '../qa/fixtures/go-live-scenarios.ts';

test('PKG20: a fresh live proxy adapter refreshes metadata for the unchanged Go module intent', async () => {
  const scenario = GO_LIVE_SCENARIOS.find(item => item.id === 'root-stabilization')!;
  const parsed = parseGoModFile(scenario.mainModule, 'strict');
  const expectedRootPaths = parsed.require.map(item => item.path).sort();
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const requested: string[] = [];
    const adapter = goProxyRunAdapter(goProxyResponseLoader(undefined, fetch, GO_PROXY_CAPTURE_BYTES));
    const loader: GoProxyLoader = async (path, signal) => {
      requested.push(path);
      const capture = await adapter.fetch(goProxyCaptureRequest(path), signal);
      if (!capture.ok) throw new Error(`live Go proxy capture failed: ${capture.reason}`);
      return capture.parsed as Uint8Array | null;
    };
    const resolution = await solveGoLiveGraph({ mainModule: scenario.mainModule, loader,
      limits: { ...GO_LIVE_LIMITS, maxFileBytes: GO_PROXY_CAPTURE_BYTES } });
    expect(resolution.status).toBe('solved');
    expect(resolution.roots.map(item => item.path).sort()).toEqual(expectedRootPaths);
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested).toHaveLength(resolution.cost.fetches);
    runs.push({ intent: scenario.mainModule, status: resolution.status, roots: resolution.roots,
      buildList: resolution.buildList, captures: requested });
  }
  expect(runs[0]!.intent).toBe(runs[1]!.intent);
  expect(runs[0]!.captures.length).toBeGreaterThan(0);
  expect(runs[1]!.captures.length).toBeGreaterThan(0);
}, 900_000);
