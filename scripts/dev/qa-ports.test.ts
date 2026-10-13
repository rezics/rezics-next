import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appEnvironment, devPorts, ensureSecrets, stackDirectory } from './config.ts';
import { leaseQaPorts, localPortRange, qaPortDiagnostic } from './qa-ports.ts';
import { processIdentity } from '../qa/process/identity.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  mkdirSync('.temp', { recursive: true });
  const root = resolve(mkdtempSync('.temp/qa-port-test-'));
  roots.push(root);
  return { root, registry: join(root, 'leases'), directory: join(root, 'stack') };
}

test('every QA service port excludes the injected kernel local port range and survives delayed use', async () => {
  const f = fixture();
  const names = [...Object.keys(devPorts()), 'ACCOUNTS_PORT'];
  const ports = await leaseQaPorts(f.directory, names, { registry: f.registry,
    localRange: [10000, 65000], candidateRange: [64000, 65535] });
  expect(Object.keys(ports)).toEqual(names);
  expect(new Set(Object.values(ports)).size).toBe(names.length);
  for (const port of Object.values(ports)) expect(port).toBeGreaterThan(65000);
  expect(await leaseQaPorts(f.directory, names, { registry: f.registry, localRange: [10000, 65000] })).toEqual(ports);
  const [first, last] = localPortRange();
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThanOrEqual(first);
});

test('sixteen concurrent processes from separate checkouts share no leased port', async () => {
  const f = fixture();
  const module = resolve(import.meta.dir, 'qa-ports.ts');
  const names = Object.keys(devPorts());
  const children = Array.from({ length: 16 }, (_, index) => Bun.spawn([process.execPath, '-e',
    `import { leaseQaPorts } from ${JSON.stringify(module)};
     console.log(JSON.stringify(await leaseQaPorts(${JSON.stringify(join(f.root, `checkout-${index}`, '.temp/stack/run'))},
       ${JSON.stringify(names)}, { registry: ${JSON.stringify(f.registry)}, localRange: [20000, 65000], candidateRange: [18000, 18200] })));`],
  { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    return JSON.parse(stdout) as Record<string, number>;
  }));
  const ports = results.flatMap(result => Object.values(result));
  expect(ports).toHaveLength(16 * names.length);
  expect(new Set(ports).size).toBe(ports.length);
});

test('a dead process lease and a removed directory lease are taken over', async () => {
  const f = fixture();
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const owner = processIdentity(child.pid)!;
    expect(owner).toBeDefined();
    const options = { registry: f.registry, localRange: [32768, 60999] as const, candidateRange: [19001, 19001] as const };
    expect(await leaseQaPorts(f.directory, ['MAIN_PORT'], { ...options, owner })).toEqual({ MAIN_PORT: 19001 });
    await expect(leaseQaPorts(join(f.root, 'blocked'), ['MAIN_PORT'], options)).rejects.toThrow('No QA ports');
    child.kill('SIGKILL');
    await child.exited;
    expect(await leaseQaPorts(join(f.root, 'successor'), ['MAIN_PORT'], options)).toEqual({ MAIN_PORT: 19001 });
    // A delayed retry from the dead owner's directory cannot reclaim the successor.
    await expect(leaseQaPorts(f.directory, ['MAIN_PORT'], options)).rejects.toThrow('No QA ports');
    rmSync(join(f.root, 'successor'), { recursive: true });
    expect(await leaseQaPorts(join(f.root, 'last'), ['MAIN_PORT'], options)).toEqual({ MAIN_PORT: 19001 });
  } finally { child.kill(); await child.exited; }
});

test('an unrelated listener is excluded without probing candidate binds', async () => {
  const f = fixture();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    await expect(leaseQaPorts(f.directory, ['MAIN_PORT'], { registry: f.registry,
      localRange: [1, 1], candidateRange: [server.port!, server.port!] })).rejects.toThrow('No QA ports');
    expect(qaPortDiagnostic(server.port!, 'MAIN_PORT')).toContain(`MAIN_PORT cannot bind leased port ${server.port}`);
    expect(qaPortDiagnostic(server.port!, 'MAIN_PORT')).toContain(`pid ${process.pid}`);
  } finally { await server.stop(true); }
});

test('QA allocation excludes both local-range boundaries and fixed dev ports even while unbound', async () => {
  const f = fixture();
  await expect(leaseQaPorts(f.directory, ['MAIN_PORT'], { registry: f.registry,
    localRange: [19100, 19101], candidateRange: [19100, 19101] })).rejects.toThrow('No QA ports');
  await expect(leaseQaPorts(f.directory, ['MAIN_PORT'], { registry: f.registry,
    localRange: [32768, 60999], candidateRange: [13030, 13030] })).rejects.toThrow('No QA ports');
});

test('the disposable stack environment reports a delayed host bind conflict with the holder', async () => {
  const f = fixture();
  const options = { profile: 'qa' as const, runId: 'diagnostics' };
  const dir = stackDirectory(f.root, options);
  const ports = await leaseQaPorts(dir, Object.keys(devPorts()), { registry: f.registry });
  const saved = ensureSecrets(f.root, options, ports);
  const env = appEnvironment(saved, dir);
  const server = Bun.serve({ hostname: '127.0.0.1', port: ports.MAIN_PORT, fetch: () => new Response('held') });
  try {
    const child = Bun.spawn([process.execPath, '-e',
      `try { Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.MAIN_PORT), fetch: () => new Response('oops') }); }
       catch (error) { console.error(error.message); process.exit(1); }`],
    { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain(`MAIN_PORT cannot bind leased port ${ports.MAIN_PORT}`);
    expect(stderr).toContain(`pid ${process.pid}`);
    expect(readFileSync(join(dir, 'qa-ports.json'), 'utf8')).toContain(String(ports.MAIN_PORT));
    expect(appEnvironment(ensureSecrets(f.root, { profile: 'dev' }), join(f.root, 'dev')).BUN_OPTIONS).toBeUndefined();
    expect(appEnvironment(ensureSecrets(f.root, { profile: 'qa', runId: 'persistent', persistent: true }), join(f.root, 'persistent')).BUN_OPTIONS).toBeUndefined();
  } finally { await server.stop(true); }
});
