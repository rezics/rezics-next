import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startDevServer, type DevServerOptions } from './support/dev-server.ts';

const root = join(import.meta.dir, '../../..');
const budgets = { ready: 2000, firstResponse: 2000, warmUp: 4000 };

function fake(
  options: {
    readyDelay?: number;
    ready?: boolean;
    status?: number;
    hydrate?: boolean;
    exit?: boolean;
    hang?: boolean;
  } = {},
): DevServerOptions {
  return {
    budgets,
    pollIntervalMs: 20,
    warmUpPaths: [],
    command: ({ port }) => [
      process.execPath,
      '-e',
      `
      const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
      process.on('SIGTERM', async () => { child.kill(); await child.exited; process.exit(0); });
      const server = Bun.serve({ hostname: '127.0.0.1', port: ${port}, fetch(request) {
        if (${!!options.hang}) return new Promise(() => {});
        if (new URL(request.url).pathname === '/pids') return Response.json([process.pid, child.pid]);
        return new Response('<!doctype html><html><body>' + process.env.HARNESS_FIXTURE +
          '<script>${options.hydrate === false ? '' : 'document.documentElement.dataset.hydrated = ""'}</script></body></html>',
          { status: ${options.status ?? 200}, headers: { 'content-type': 'text/html' } });
      }});
      console.log('fixture output');
      ${options.ready === false ? '' : `setTimeout(() => console.log('VITE v7 ready in 1 ms'), ${options.readyDelay ?? 0});`}
      ${options.exit ? 'setTimeout(async () => { child.kill(); await child.exited; process.exit(23); }, 80);' : ''}
    `,
    ],
  };
}

async function failure(options: DevServerOptions) {
  try {
    const server = await startDevServer(options);
    await server.stop();
    throw new Error('startup unexpectedly succeeded');
  } catch (error) {
    return String(error);
  }
}

function report(error: string, phase: string, path: string, last: RegExp) {
  expect(error).toContain(phase);
  expect(error).toContain(path);
  expect(error).toMatch(/elapsed[^\n]*\d+\s*ms/i);
  expect(error).toMatch(/last error:/i);
  expect(error).toMatch(last);
  expect(error).toContain('fixture output');
}

async function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('startDevServer returns after ready, the first response and every hydrated warm-up, and stop ends the process group', async () => {
  const phases: { phase: string; path: string; elapsedMs: number }[] = [];
  const server = await startDevServer({
    ...fake(),
    env: { HARNESS_FIXTURE: 'environment preserved' },
    warmUpPaths: ['/warm', '/other'],
    onPhase: (phase) => phases.push(phase),
  });
  let pids: number[] = [];
  try {
    expect(await (await fetch(`${server.origin}/warm`)).text()).toContain('environment preserved');
    pids = await (await fetch(`${server.origin}/pids`)).json();
    expect(phases.map(({ phase, path }) => [phase, path])).toEqual([
      ['ready', '/en'],
      ['first response', '/en'],
      ['warm-up', '/warm'],
      ['warm-up', '/other'],
    ]);
    expect(phases.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
  } finally {
    await server.stop();
  }
  await server.stop();
  for (const pid of pids) expect(await alive(pid), `process ${pid}`).toBe(false);
}, 15_000);

test('a server that never prints ready names the ready phase, path, elapsed time, last error and output', async () => {
  report(
    await failure({ ...fake({ ready: false }), budgets: { ...budgets, ready: 150 } }),
    'ready',
    '/en',
    /ready line/i,
  );
});

test('a server that only answers 503 names the first-response phase and last HTTP error', async () => {
  report(
    await failure({ ...fake({ status: 503 }), budgets: { ...budgets, firstResponse: 150 } }),
    'first response',
    '/en',
    /HTTP 503/,
  );
});

test('a hanging response cannot exceed its phase budget', async () => {
  const began = Date.now();
  report(
    await failure({ ...fake({ hang: true }), budgets: { ...budgets, firstResponse: 150 } }),
    'first response',
    '/en',
    /abort|timeout|timed out/i,
  );
  expect(Date.now() - began).toBeLessThan(2000);
});

test('a warm-up that never hydrates names its path and the browser error', async () => {
  report(
    await failure({ ...fake({ hydrate: false }), warmUpPaths: ['/unhydrated'], budgets: { ...budgets, warmUp: 1500 } }),
    'warm-up',
    '/unhydrated',
    /hydrated|Timeout/,
  );
}, 10_000);

test('a warm-up HTTP failure names its path and status', async () => {
  const options = fake();
  const command = options.command!;
  report(
    await failure({
      ...options,
      warmUpPaths: ['/broken'],
      command: (context) =>
        command(context).map((part) =>
          part.replace('status: 200', "status: new URL(request.url).pathname === '/broken' ? 503 : 200"),
        ),
    }),
    'warm-up',
    '/broken',
    /HTTP 503/,
  );
}, 10_000);

test('warm-up can disable JavaScript without waiting for hydration', async () => {
  const server = await startDevServer({ ...fake({ hydrate: false }), warmUpPaths: ['/ssr'], javaScriptEnabled: false });
  await server.stop();
}, 10_000);

test('a process exiting during startup fails immediately with its code and output', async () => {
  const began = Date.now();
  const error = await failure({ ...fake({ ready: false, exit: true }), budgets: { ...budgets, ready: 10_000 } });
  expect(error).toContain('23');
  expect(error).toContain('fixture output');
  expect(Date.now() - began).toBeLessThan(2000);
});

test('an exit while waiting for a response also fails immediately', async () => {
  const began = Date.now();
  const error = await failure({ ...fake({ hang: true, exit: true }), budgets: { ...budgets, firstResponse: 10_000 } });
  expect(error).toContain('23');
  expect(error).toContain('fixture output');
  expect(Date.now() - began).toBeLessThan(2000);
});

test('first-response and warm-up budgets start at the ready line, after a slow process start', async () => {
  const server = await startDevServer({
    ...fake({ readyDelay: 900 }),
    budgets: { ready: 2000, firstResponse: 600, warmUp: 4000 },
    warmUpPaths: ['/after-slow-start'],
  });
  await server.stop();
}, 10_000);

test('hydration and search SEO use the shared starter and preserve their startup settings and page assertions', async () => {
  for (const name of ['hydration', 'search-seo']) {
    const source = await Bun.file(join(import.meta.dir, `${name}.test.ts`)).text();
    expect(source).toMatch(/import\s*\{[^}]*startDevServer[^}]*\}\s*from\s*['"]\.\/support\/dev-server\.ts['"]/);
    expect(source).toContain('startDevServer(');
    expect(source).not.toMatch(/\bspawn\(/);
    // These two original loops have no warm-up paths.
    expect(source).toMatch(/warmUpPaths:\s*\[\]/);
    expect(source).toContain("page.locator('html[data-hydrated]')");
    if (name === 'hydration') {
      expect(source).toContain('Emulation.setCPUThrottlingRate');
      expect(source).toContain('javaScriptEnabled: false');
    } else {
      for (const setting of [
        'KERNEL_ORIGIN: fake.url.origin',
        'AUTH_ISSUER: `${fake.url.origin}/auth`',
        'WEBSITE_CLIENT_ID: clientId',
        'WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk)',
        'API_RESOURCE: resource',
        "WEBSITE_SCOPES: scopes.join(' ')",
        "PUBLIC_ORIGIN: 'https://rezics.test'",
      ])
        expect(source).toContain(setting);
      expect(source).toContain("toBe('noindex, follow')");
      expect(source).toContain('expect(searches(before)).toHaveLength(1)');
    }
  }
});

function testModuleImports(source: string, loader: 'ts' | 'tsx' = 'ts'): string[] {
  // Keep type-only imports visible to the scanner as well as runtime imports.
  const imports = source
    .replace(/\bimport\s+type(?=\s|\{)/g, 'import')
    .replace(/\bexport\s+type(?=\s*[{*])/g, 'export')
    .replace(
      /(\b(?:import|export)\s*\{)([^}]*)(\}\s*from)/g,
      (_, before: string, names: string, after: string) => before + names.replace(/\btype\s+/g, '') + after,
    );
  return new Bun.Transpiler({ loader })
    .scanImports(imports)
    .map(({ path }) => path)
    .filter((path) => /\.test(?:\.ts)?$/.test(path));
}

test('the source scan sees static, type-only and dynamic imports without treating strings as imports', () => {
  expect(
    testModuleImports(`
    import './static.test';
    import type { Fixture } from './types.test.ts';
    import { type Other } from './inline.test.ts';
    export type { Reused } from './exported.test.ts';
    const lazy = import(/* a comment */ './lazy.test.ts');
    const text = "import './not-an-import.test.ts'";
  `).sort(),
  ).toEqual(['./exported.test.ts', './inline.test.ts', './lazy.test.ts', './static.test', './types.test.ts']);
});

test('no web or UI test imports another test module, statically or with import()', async () => {
  const violations: string[] = [];
  for (const directory of ['apps/web/tests', 'packages/ui/tests']) {
    for (const file of new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}').scanSync({ cwd: join(root, directory) })) {
      const source = await Bun.file(join(root, directory, file)).text();
      for (const specifier of testModuleImports(source, /\.[jt]sx$/.test(file) ? 'tsx' : 'ts'))
        violations.push(`${directory}/${file}: ${specifier}`);
    }
  }
  expect(violations).toEqual([]);
});

test('a slow start cannot consume the warm-up budget either', async () => {
  const server = await startDevServer({
    ...fake({ readyDelay: 4500 }),
    budgets: { ready: 7000, firstResponse: 2000, warmUp: 4000 },
    warmUpPaths: ['/fresh-warm-up-budget'],
  });
  await server.stop();
}, 15_000);

test('a parent exit fails immediately even when its child keeps the output pipe open', async () => {
  const options = fake({ ready: false, exit: true });
  const command = options.command!;
  const began = Date.now();
  const error = await failure({
    ...options,
    budgets: { ...budgets, ready: 10_000 },
    command: (context) =>
      command(context).map((part) =>
        part
          .replace(
            "'setInterval(() => {}, 1000)']);",
            "'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' });",
          )
          .replace('child.kill(); await child.exited; process.exit(23)', 'process.exit(23)'),
      ),
  });
  expect(error).toContain('23');
  expect(error).toContain('fixture output');
  expect(Date.now() - began).toBeLessThan(2000);
});
