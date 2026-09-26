import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { npmSha, npmStable } from '../../services/main/src/modules/package/npm-lock.ts';
import { resolveNpmRegistry, revalidateNpmRegistry }
  from '../../services/main/src/modules/package/npm-registry-capture.ts';
import { explainNpmDivergence, type NpmNativeObservation }
  from '../../services/main/src/modules/package/npm-divergence.ts';
import { parseNpmRange, parseNpmVersion, npmSatisfies } from '../../services/main/src/modules/package/npm-semver.ts';
import { npmRegistryLiveScenarios, npmRegistryRequest } from '../qa/fixtures/npm-registry-scenarios.ts';

// PKG03/PKG04/PKG12/PKG20 live oracle: capture the current registry once per scenario, solve it with
// REZICS, then serve the exact captured bytes to pinned npm 11.19.1 over loopback and explain any
// divergence. `NPM_LIVE_UPDATE_FIXTURE=1` refreshes the frozen QA fixture from this run.
const cli = realpathSync(Bun.which('npm') ?? '/missing-npm');
const npmRoot = resolve(dirname(cli), '..');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const output = resolve(import.meta.dir, '../../.artifacts/npm-live', runId);

async function run(args: string[], cwd: string, home: string) {
  const child = Bun.spawn(['node', cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH, HOME: home, NODE_ENV: 'test', npm_config_userconfig: join(home, 'npmrc'),
      npm_config_globalconfig: join(home, 'global-npmrc'), npm_config_cache: join(home, 'cache'),
      npm_config_update_notifier: 'false' } });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}

test('PKG03/PKG04/PKG12/PKG20: live registry snapshots solve like native npm 11.19.1 or diverge with explanations', async () => {
  const npmPackage = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as { version: string };
  expect(npmPackage.version).toBe('11.19.1');
  const semver = await import(join(npmRoot, 'node_modules/semver/index.js')) as {
    satisfies(version: string, range: string, options: object): boolean };
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const fixture: Record<string, unknown> = {};
  const summary: Record<string, unknown> = {};
  let semverChecks = 0;
  for (const scenario of npmRegistryLiveScenarios) {
    const request = npmRegistryRequest(scenario);
    const digest = npmSha(npmStable(request));
    const raw = new Map<string, Uint8Array>();
    const started = performance.now();
    const outcome = await resolveNpmRegistry(request, digest, { observe: (url, bytes) => raw.set(url, bytes) });
    const elapsedMs = Math.round(performance.now() - started);
    // Retained snapshot is a sufficient replay witness for the same outcome.
    expect(npmStable(await revalidateNpmRegistry(request, digest, outcome.sourceSnapshot))).toBe(npmStable(outcome));
    expect(outcome.status).toBe(scenario.expect.status);
    // Differential semver: every retained candidate against every range REZICS consulted.
    for (const packument of outcome.sourceSnapshot.packuments) {
      const ranges = new Set(outcome.edges.map(edge => edge.effectiveSpec.startsWith('npm:')
        ? edge.effectiveSpec.slice(edge.effectiveSpec.lastIndexOf('@') + 1) : edge.effectiveSpec)
        .filter(spec => parseNpmRange(spec)));
      for (const record of packument.records) for (const range of ranges) {
        semverChecks += 1;
        expect([record.version, range, npmSatisfies(parseNpmVersion(record.version)!, parseNpmRange(range)!)])
          .toEqual([record.version, range, semver.satisfies(record.version, range, { loose: true })]);
      }
    }
    let native: NpmNativeObservation | null = null;
    const requested: string[] = [];
    if (scenario.native) {
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(incoming) {
        const path = new URL(incoming.url).pathname;
        requested.push(path);
        const bytes = raw.get(`https://registry.npmjs.org${path}`)
          ?? raw.get(`https://registry.npmjs.org${path.replace(/^\/(@[^/]+)\//, '/$1%2f')}`);
        return bytes ? new Response(bytes, { headers: { 'content-type': 'application/json' } })
          : new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
      } });
      try {
        const directory = join(output, scenario.name);
        const home = join(directory, '.home');
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'npmrc'), '');
        writeFileSync(join(home, 'global-npmrc'), '');
        writeFileSync(join(directory, 'package.json'), Buffer.from(request.manifest.bytesBase64, 'base64'));
        for (const workspace of request.workspaces) {
          mkdirSync(join(directory, workspace.path), { recursive: true });
          writeFileSync(join(directory, workspace.path, 'package.json'), Buffer.from(workspace.manifest.bytesBase64, 'base64'));
        }
        const strategy = request.strategy.replace(/^npm-/, '');
        const result = await run(['install', '--package-lock-only', '--ignore-scripts', '--strict-peer-deps',
          '--legacy-peer-deps=false', '--no-audit', '--no-fund', `--registry=http://127.0.0.1:${server.port}/`,
          '--replace-registry-host=never', `--install-strategy=${strategy}`, `--os=${request.target.os}`,
          `--cpu=${request.target.cpu}`, '--prefer-online', '--fetch-retries=0'], directory, home);
        writeFileSync(join(directory, 'npm-stderr.txt'), result.stderr);
        if (result.exitCode === 0) {
          const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
          native = { status: 'solved', lock: { lockfileVersion: lock.lockfileVersion, packages: lock.packages } };
        } else {
          native = { status: 'failed', code: /npm error code (\S+)/.exec(result.stderr)?.[1] ?? `exit-${result.exitCode}` };
        }
      } finally { await server.stop(true); }
    }
    const report = native ? explainNpmDivergence(outcome, native) : null;
    if (report) {
      expect(report.correspondence).toBe(scenario.expect.correspondence);
      for (const divergence of report.divergences) expect(scenario.expect.allowedDivergences).toContain(divergence.kind);
    }
    summary[scenario.name] = { status: outcome.status, artifactVerification: outcome.artifactVerification,
      correspondence: report?.correspondence ?? null, divergences: report?.divergences ?? [], elapsedMs,
      cost: outcome.cost, nativeRequests: requested.length, conflict: outcome.conflict,
      unsupported: outcome.unsupportedClauses };
    fixture[scenario.name] = { request, requestDigest: digest, outcomeDigest: npmSha(npmStable(outcome)),
      status: outcome.status, snapshot: outcome.sourceSnapshot, native,
      correspondence: report?.correspondence ?? null, capturedAt: new Date().toISOString() };
  }
  expect(semverChecks).toBeGreaterThan(100);
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ runId, npm: npmPackage.version, semverChecks, summary }, null, 2));
  const fixtureText = `${JSON.stringify(fixture)}\n`;
  writeFileSync(join(output, 'fixture.json'), fixtureText);
  if (Bun.env.NPM_LIVE_UPDATE_FIXTURE === '1') {
    writeFileSync(resolve(import.meta.dir, '../qa/fixtures/npm-registry-live.json'), fixtureText);
  }
  console.info(`npm live oracle ${runId}: ${Object.keys(summary).length} scenarios, ${semverChecks} semver checks, sha256 ${
    createHash('sha256').update(fixtureText).digest('hex')}; ${output}`);
}, 600_000);
