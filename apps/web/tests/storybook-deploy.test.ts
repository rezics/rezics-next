import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { formatBuildOutput } from '../scripts/storybook-build-output.ts';
import { runDeployment, runStatus } from '../scripts/storybook-deploy.ts';
import { smokeStorybook } from '../scripts/storybook-smoke.ts';
import { generateRoutes } from '../.storybook/route-generation.ts';
import type { Plugin, ResolvedConfig } from 'vite';

const root = resolve(import.meta.dir, '../../../');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
const cloudflareOutput = resolve(app, '.cloudflare/output');
let browser: Browser;
let previewServer: ReturnType<typeof Bun.serve>;
let expectedCommit: string;

describe('Storybook route preparation', () => {
  test('generates the complete current route tree with the current Start configuration without a runtime', async () => {
    const production = readFileSync(resolve(app, 'vite.config.ts'), 'utf8');
    expect(production).toContain('tanstackStart(),');
    const sources = ['generate-routes.ts', 'route-generation.ts'].map((name) =>
      readFileSync(resolve(app, '.storybook', name), 'utf8'),
    );
    expect(sources.join('\n')).not.toMatch(/from ['"](?:vite|@cloudflare\/|@tanstack\/react-start)/);
    expect(sources.join('\n')).not.toMatch(/createServer|optimizeDeps|vite\.config/);
    const webPackage = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'));
    const installedGenerator = JSON.parse(
      readFileSync(resolve(app, 'node_modules/@tanstack/router-generator/package.json'), 'utf8'),
    );
    expect(webPackage.devDependencies['@tanstack/router-generator']).toBe(installedGenerator.version);
    expect(webPackage.scripts['generate:routes']).toBe('node .storybook/generate-routes.ts');

    await generateRoutes(app);
    const tree = readFileSync(resolve(app, 'src/routeTree.gen.ts'), 'utf8');
    const routeFiles = readdirSync(resolve(app, 'src/routes'), { recursive: true }).filter((name) =>
      /\.(ts|tsx)$/.test(name),
    );
    expect(routeFiles.length).toBeGreaterThan(0);
    for (const name of routeFiles) {
      const modulePath = `./routes/${name.replaceAll('\\', '/').replace(/\.(ts|tsx)$/, '')}`;
      expect(tree).toContain(`from '${modulePath}'`);
    }
    expect(tree).toContain("import type { getRouter } from './router.tsx'");
    expect(tree).toContain("import type { startInstance } from './start.ts'");
    expect(tree).toContain("declare module '@tanstack/react-start'");
    expect(tree).toContain('ssr: true');
    expect(tree).toContain('router: Awaited<ReturnType<typeof getRouter>>');
    expect(tree).toContain('config: Awaited<ReturnType<typeof startInstance.getOptions>>');
  });

  test('regenerates additions, renames and removals using TanStack filename and parameter handling', async () => {
    mkdirSync(resolve(root, '.temp'), { recursive: true });
    const fixture = mkdtempSync(resolve(root, '.temp/storybook-routes-'));
    const routes = resolve(fixture, 'src/routes');
    const readTree = () => readFileSync(resolve(fixture, 'src/routeTree.gen.ts'), 'utf8');
    const routeSource =
      "import { createFileRoute } from '@tanstack/react-router'; export const Route = createFileRoute('/placeholder')({});";
    try {
      mkdirSync(routes, { recursive: true });
      writeFileSync(resolve(fixture, 'vite.config.ts'), "throw new Error('production Vite config was loaded');");
      writeFileSync(
        resolve(routes, '__root.tsx'),
        "import { createRootRoute } from '@tanstack/react-router'; export const Route = createRootRoute(); throw new Error('route module was evaluated');",
      );
      await generateRoutes(fixture);
      writeFileSync(resolve(routes, '@{$handle}.tsx'), routeSource);
      writeFileSync(resolve(routes, 'robots[.]txt.ts'), routeSource);
      await generateRoutes(fixture);
      expect(readTree()).toContain("'/@{$handle}'");
      expect(readTree()).toContain("'/robots.txt'");
      renameSync(resolve(routes, '@{$handle}.tsx'), resolve(routes, 'people.$handle.tsx'));
      rmSync(resolve(routes, 'robots[.]txt.ts'));
      await generateRoutes(fixture);
      expect(readTree()).toContain("'/people/$handle'");
      expect(readTree()).not.toContain('/@{$handle}');
      expect(readTree()).not.toContain('/robots.txt');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('propagates generation failure through the Node entry point even when ignored output exists', () => {
    mkdirSync(resolve(root, '.temp'), { recursive: true });
    const fixture = mkdtempSync(resolve(root, '.temp/storybook-routes-failure-'));
    try {
      mkdirSync(resolve(fixture, 'src/routes'), { recursive: true });
      writeFileSync(resolve(fixture, 'src/routeTree.gen.ts'), '// stale output');
      const result = Bun.spawnSync(['node', resolve(app, '.storybook/generate-routes.ts')], {
        cwd: fixture,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/root route|__root/);
      expect(readFileSync(resolve(fixture, 'src/routeTree.gen.ts'), 'utf8')).toBe('// stale output');

      const main = readFileSync(resolve(app, '.storybook/main.ts'), 'utf8');
      const preparation = main.slice(0, main.indexOf('const config: StorybookConfig'));
      expect(preparation).toContain("spawnSync('node', ['.storybook/generate-routes.ts']");
      expect(preparation).not.toMatch(/existsSync|mtime|statSync/);
      expect(preparation).toContain('if (result.error) throw result.error');
      expect(preparation).toMatch(/if \(result.status !== 0\) throw new Error/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('Storybook browser route boundary', () => {
  async function prepare() {
    const storybook = (await import('../.storybook/main.ts')).default;
    const react: Plugin = { name: 'vite:react-babel' };
    const config = await storybook.viteFinal!({ plugins: [react] }, {} as never);
    const plugins = (await Promise.all(config.plugins ?? [])).flat(Infinity).filter(Boolean) as Plugin[];
    const compiler = plugins.find((plugin) => plugin.name === 'tanstack-router:code-splitter:compile-reference-file');
    expect(compiler).toBeDefined();
    expect(plugins.indexOf(compiler!)).toBeLessThan(plugins.indexOf(react));
    expect(plugins.some((plugin) => /cloudflare|tanstack-start/.test(plugin.name))).toBe(false);
    const configure = compiler!.configResolved!;
    await (typeof configure === 'function' ? configure : configure.handler)({
      root: app,
      command: 'build',
      plugins,
    } as ResolvedConfig);
    const hook = compiler!.transform!;
    const transform = typeof hook === 'function' ? hook : hook.handler;
    return async (path: string) => {
      const source = readFileSync(resolve(app, path), 'utf8');
      const result = await transform.call({} as never, source, resolve(app, path), { ssr: false });
      return { source, code: typeof result === 'string' ? result : (result?.code ?? source) };
    };
  }

  test('keeps the actual card route while removing its native execution imports from the browser', async () => {
    const transform = await prepare();
    const { source, code } = await transform('src/routes/cards/$id.ts');
    const imports = (text: string) => new Bun.Transpiler({ loader: 'ts' }).scanImports(text).map(({ path }) => path);
    expect(imports(source)).toContain('../../media/share-card.worker');
    expect(source).toContain('GET: respond, HEAD: respond');
    expect(imports(code)).toEqual(['@tanstack/react-router']);
    expect(code).not.toContain('currentShareCardResponse');
    expect(code).toContain('/cards/$id');
    expect(code).toContain('publicCache: false');
    const tree = readFileSync(resolve(app, 'src/routeTree.gen.ts'), 'utf8');
    expect(tree).toContain("from './routes/cards/$id'");
  });

  test('retains actual UI loaders, recorded read imports, heads and components on mixed routes', async () => {
    const transform = await prepare();
    const { code } = await transform('src/routes/library/labels.tsx');
    const imports = new Bun.Transpiler({ loader: 'tsx' }).scanImports(code).map(({ path }) => path);
    expect(imports).toContain('../../library/labels-read-route');
    expect(imports).toContain('../../library/labels-page');
    expect(imports).toContain('../../shell/head');
    expect(imports).not.toContain('../../library/labels-actions');
    expect(code).toContain('/library/labels');
    for (const retained of [
      'validateSearch',
      'loaderDeps',
      'loader:',
      'readLabelsPage',
      'head:',
      'component:',
      'LabelsPageView',
    ])
      expect(code).toContain(retained);

    // The root's real providers, shell, locale and public head stay in the same module.
    const root = await transform('src/routes/__root.tsx');
    expect(root.code).toBe(root.source);
    const handlers = await transform('.storybook/react-start.ts');
    expect(handlers.code).toBe(handlers.source);
  });
});

describe('failed build diagnostics', () => {
  test('retains the native fatal prelude and terminal socket error alongside useful stdout', () => {
    const prelude = 'FATAL: native startup aborted\n';
    const terminal = '\nerror: local socket closed';
    const stdout = 'Generating export types\nStarting Storybook';
    const details = formatBuildOutput(stdout, `${prelude}${'native detail\n'.repeat(2_000)}${terminal}`);

    expect(details.startsWith(`[stderr]\n${prelude}`)).toBe(true);
    expect(details).toContain(`${terminal}\n[stdout]\n${stdout}`);
    expect(details).toContain('[output omitted]');
    expect(details.split(prelude)).toHaveLength(2);
    expect(details.split(terminal)).toHaveLength(2);
    expect(details.length).toBeLessThanOrEqual(8_000);
  });

  test('preserves short output completely and identifies each nonempty stream', () => {
    expect(formatBuildOutput('build progress\n', 'fatal error\n')).toBe(
      '[stderr]\nfatal error\n\n[stdout]\nbuild progress\n',
    );
    expect(formatBuildOutput('', 'fatal error')).toBe('[stderr]\nfatal error');
    expect(formatBuildOutput('build progress', '')).toBe('[stdout]\nbuild progress');
    expect(formatBuildOutput('', '')).toBe('');
  });

  test('bounds combined output including labels and omission markers as either stream grows', () => {
    for (const scale of [1, 8, 64]) {
      const stderr = `fatal prelude\n${'e'.repeat(8_000 * scale)}\nterminal socket error`;
      const stdout = `stdout beginning\n${'o'.repeat(8_000 * scale)}\nstdout ending`;
      const streams = [
        [stdout, stderr],
        [stdout, 'short stderr'],
        ['short stdout', stderr],
      ] as const;
      for (const [out, err] of streams) {
        const details = formatBuildOutput(out, err);
        expect(details.length).toBeLessThanOrEqual(8_000);
        expect(details).toContain('[output omitted]');
        expect(details.startsWith(`[stderr]\n${err.slice(0, 13)}`)).toBe(true);
        expect(details).toContain(`${err.slice(-21)}\n[stdout]\n${out.slice(0, 16)}`);
        expect(details.endsWith(out.slice(-13))).toBe(true);
      }
    }
  });
});

function countStories(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return count + countStories(path);
    if (!entry.name.endsWith('.stories.tsx')) return count;
    return count + (readFileSync(path, 'utf8').match(/^export const \w+\s*:/gm)?.length ?? 0);
  }, 0);
}

beforeAll(async () => {
  rmSync(cloudflareOutput, { recursive: true, force: true });
  const gitCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  expectedCommit = gitCommit.exitCode === 0 ? gitCommit.stdout.toString().trim() : '0'.repeat(40);
  const build = Bun.spawnSync(['bun', 'run', '--cwd', 'apps/web', 'storybook:build'], {
    cwd: root,
    env: { ...process.env, STORYBOOK_COMMIT: expectedCommit, STORYBOOK_OUTPUT_DIR: output },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(build.exitCode).toBe(0);
  expect(existsSync(cloudflareOutput)).toBe(false);
  browser = await chromium.launch({ headless: true });
  previewServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = resolve(output, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!path.startsWith(`${output}/`)) return new Response('not found', { status: 404 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  previewServer?.stop(true);
});

describe('storybook review build', () => {
  test('builds both catalogues into one site with complete indexes and build metadata', () => {
    const index = JSON.parse(readFileSync(resolve(output, 'index.json'), 'utf8')) as {
      entries: Record<string, { title: string; type: string }>;
    };
    const uiIndex = JSON.parse(readFileSync(resolve(output, 'ui/index.json'), 'utf8')) as {
      entries: Record<string, { title: string; type: string }>;
    };
    const webStories = Object.values(index.entries).filter((entry) => entry.type === 'story');
    expect(webStories.length).toBeGreaterThanOrEqual(countStories(resolve(app, 'src/stories')));
    expect(webStories.filter((entry) => /^(Pages|Patterns|Interfaces|Families)\//.test(entry.title))).toEqual([]);
    expect(Object.values(uiIndex.entries).filter((entry) => entry.type === 'story').length).toBeGreaterThanOrEqual(
      countStories(resolve(root, 'packages/ui/src')),
    );
    expect(Object.values(index.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(Object.values(uiIndex.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(existsSync(resolve(output, 'ui/index.html'))).toBe(true);

    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      storybookVersion: string;
      builtAt: string;
    };
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.storybookVersion).toMatch(/^11\./);
    expect(Number.isNaN(Date.parse(metadata.builtAt))).toBe(false);
    expect(metadata.builtAt).toMatch(/Z$/);
    expect(metadata.commit).toBe(expectedCommit);
  });

  test('serves deep links for a page, a composed UI story, a translated dark story, and recorded cover media', async () => {
    expect(previewServer).toBeDefined();
    await smokeStorybook(previewServer.url.toString(), browser);
    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      builtAt: string;
    };
    const page = await browser.newPage();
    try {
      await page.goto(previewServer.url.toString());
      await page.waitForFunction((expected) => document.title.includes(expected), metadata.commit.slice(0, 7));
      expect(await page.title()).toContain(metadata.builtAt);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('deployment sequencing', () => {
  test('status prints live and local commits and exits 0 when they match without building or calling Wrangler', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    const commit = 'a'.repeat(40);
    const status = await runStatus({
      localCommit: commit,
      fetchBuild: async () => {
        calls.push('fetch');
        return { commit };
      },
      print: (line) => outputLines.push(line),
    });
    expect(status).toBe(0);
    expect(calls).toEqual(['fetch']);
    expect(outputLines.join('\n')).toContain(`Live commit: ${commit}`);
    expect(outputLines.join('\n')).toContain(`Local commit: ${commit}`);
  });

  test('status exits 3 for a different live commit and 2 when the live build cannot be read', async () => {
    const outputLines: string[] = [];
    const localCommit = 'a'.repeat(40);
    let reads = 0;
    const behindStatus = await runStatus({
      localCommit,
      fetchBuild: async () => {
        reads++;
        return { commit: 'b'.repeat(40) };
      },
      print: (line) => outputLines.push(line),
    });
    expect(behindStatus).toBe(3);
    expect(reads).toBe(1);
    expect(outputLines.join('\n')).toContain(`Live commit: ${'b'.repeat(40)}`);

    for (const fetchBuild of [
      async () => ({}),
      async () => {
        throw new Error('unavailable');
      },
    ]) {
      const unavailableStatus = await runStatus({
        localCommit,
        fetchBuild: async () => {
          reads++;
          return fetchBuild();
        },
        print: (line) => outputLines.push(line),
      });
      expect(unavailableStatus).toBe(2);
    }
    expect(reads).toBe(3);
  });

  test('a real deployment skips a commit already published without building, uploading or routing', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    const commit = 'a'.repeat(40);
    await runDeployment({
      dryRun: false,
      commit,
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async () => {
        calls.push('wrangler');
        return '';
      },
      fetchBuild: async () => {
        calls.push('fetch');
        return { commit };
      },
      isTreeClean: async () => {
        calls.push('clean');
        return [];
      },
      print: (line) => outputLines.push(line),
    });
    expect(calls).toEqual(['clean', 'fetch']);
    expect(outputLines.join('\n')).toContain(`Already published ${commit}`);
  });

  test('a forced deployment publishes when the commit is already live', async () => {
    const calls: string[] = [];
    const commit = 'a'.repeat(40);
    await runDeployment({
      dryRun: false,
      force: true,
      commit,
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(args[1]!);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      fetchBuild: async () => {
        calls.push('fetch');
        return { commit };
      },
      isTreeClean: async () => {
        calls.push('clean');
        return [];
      },
      print: () => {},
    });
    expect(calls).toEqual(['clean', 'build', 'smoke', 'upload', 'deploy', 'deploy', 'fetch']);
  });

  test('a real deployment refuses a dirty tree before building and names changed paths', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    await expect(
      runDeployment({
        dryRun: false,
        commit: 'a'.repeat(40),
        build: async () => {
          calls.push('build');
        },
        smoke: async () => {},
        wrangler: async () => {
          calls.push('wrangler');
          return '';
        },
        isTreeClean: async () => ['apps/web/src/changed.ts', 'packages/ui/src/changed.tsx'],
        print: (line) => outputLines.push(line),
      }),
    ).rejects.toThrow(/apps\/web\/src\/changed\.ts.*packages\/ui\/src\/changed\.tsx/);
    expect(calls).toEqual([]);
    expect(outputLines.join('\n')).toContain('apps/web/src/changed.ts');
    expect(outputLines.join('\n')).toContain('packages/ui/src/changed.tsx');
  });

  test('removes leftover Cloudflare build output before Wrangler in real and dry-run deployments', async () => {
    mkdirSync(resolve(root, '.temp'), { recursive: true });
    for (const dryRun of [false, true]) {
      const cloudflareOutputDir = mkdtempSync(resolve(root, '.temp/storybook-cloudflare-output-'));
      const calls: string[][] = [];
      const outputLines: string[] = [];
      let liveReads = 0;
      try {
        await runDeployment({
          dryRun,
          commit: 'a'.repeat(40),
          cloudflareOutputDir,
          build: async () => {
            mkdirSync(cloudflareOutputDir, { recursive: true });
            writeFileSync(resolve(cloudflareOutputDir, 'worker.js'), 'leftover');
          },
          smoke: async () => {},
          wrangler: async (args) => {
            expect(existsSync(cloudflareOutputDir)).toBe(false);
            calls.push(args);
            return dryRun
              ? 'dry run'
              : 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev';
          },
          fetchBuild: async () => ({ commit: ++liveReads === 1 ? 'b'.repeat(40) : 'a'.repeat(40) }),
          isTreeClean: async () => [],
          print: (line) => outputLines.push(line),
        });
        expect(calls.length).toBeGreaterThan(0);
        expect(outputLines.some((line) => line.includes('Removed leftover Cloudflare build output'))).toBe(true);
      } finally {
        rmSync(cloudflareOutputDir, { recursive: true, force: true });
      }
    }
  });

  test('uploads only after build and smoke pass, then routes and prints that version preview URL', async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const outputLines: string[] = [];
    const expected = 'a'.repeat(40);
    let liveReads = 0;
    await runDeployment({
      dryRun: false,
      commit: expected,
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(args[1]!);
        events.push(`${args[0]} ${args[1]}`);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      fetchBuild: async () => {
        events.push('verify live build');
        liveReads++;
        return { commit: liveReads === 1 ? 'b'.repeat(40) : expected };
      },
      isTreeClean: async () => [],
      print: (line) => outputLines.push(line),
    });
    expect(calls).toEqual(['build', 'smoke', 'upload', 'deploy', 'deploy']);
    expect(events).toEqual([
      'verify live build',
      'versions upload',
      'versions deploy',
      'triggers deploy',
      'verify live build',
    ]);
    expect(events.filter((event) => event === 'verify live build')).toHaveLength(2);
    expect(outputLines.join('\n')).toContain('https://ver-123.storybook.rezics.workers.dev');
  });

  test('a publishing deployment reads the live build before building and after routing', async () => {
    let liveReads = 0;
    const calls: string[] = [];
    await runDeployment({
      dryRun: false,
      commit: 'a'.repeat(40),
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(args[1]!);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      fetchBuild: async () => ({ commit: ++liveReads === 1 ? 'b'.repeat(40) : 'a'.repeat(40) }),
      isTreeClean: async () => [],
      print: () => {},
    });
    expect(calls).toContain('upload');
    expect(liveReads).toBe(2);
  });

  test('a real deployment without a resolved commit fails before checking the tree or building', async () => {
    const calls: string[] = [];
    await expect(
      runDeployment({
        dryRun: false,
        build: async () => {
          calls.push('build');
        },
        smoke: async () => {
          calls.push('smoke');
        },
        wrangler: async () => {
          calls.push('wrangler');
          return '';
        },
        fetchBuild: async () => {
          calls.push('fetch');
          return {};
        },
        isTreeClean: async () => {
          calls.push('clean');
          return [];
        },
        print: () => {},
      }),
    ).rejects.toThrow(/commit SHA is required/);
    expect(calls).toEqual([]);
  });

  test('a forced deployment still refuses a dirty tree before building', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    await expect(
      runDeployment({
        dryRun: false,
        force: true,
        commit: 'a'.repeat(40),
        build: async () => {
          calls.push('build');
        },
        smoke: async () => {
          calls.push('smoke');
        },
        wrangler: async () => {
          calls.push('wrangler');
          return '';
        },
        fetchBuild: async () => {
          calls.push('fetch');
          return {};
        },
        isTreeClean: async () => ['apps/web/uncommitted.ts'],
        print: (line) => outputLines.push(line),
      }),
    ).rejects.toThrow('apps/web/uncommitted.ts');
    expect(calls).toEqual([]);
    expect(outputLines.join('\n')).toContain('apps/web/uncommitted.ts');
  });

  test('an unreadable live build before publishing still deploys and verifies the routed commit', async () => {
    const commit = 'a'.repeat(40);
    const calls: string[] = [];
    const outputLines: string[] = [];
    await runDeployment({
      dryRun: false,
      commit,
      isTreeClean: async () => {
        calls.push('clean');
        return [];
      },
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(`${args[0]} ${args[1]}`);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      fetchBuild: async () => {
        const alreadyRead = calls.includes('fetch');
        calls.push('fetch');
        if (!alreadyRead) throw new Error('live build unavailable');
        return { commit };
      },
      print: (line) => outputLines.push(line),
    });
    expect(calls).toEqual([
      'clean',
      'fetch',
      'build',
      'smoke',
      'versions upload',
      'versions deploy',
      'triggers deploy',
      'fetch',
    ]);
    expect(outputLines.join('\n')).toContain('Published ver-123');
  });

  test('a dry run validates a dirty tree without reading its state or the live build', async () => {
    const calls: string[] = [];
    await runDeployment({
      dryRun: true,
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(args.join(' '));
        return 'dry run';
      },
      isTreeClean: async () => {
        calls.push('clean');
        return ['uncommitted.ts'];
      },
      fetchBuild: async () => {
        calls.push('fetch');
        return {};
      },
      print: () => {},
    });
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2)).toEqual(['build', 'smoke']);
    expect(calls[2]).toStartWith('deploy --dry-run --config ');
  });

  test('dry run invokes Wrangler dry run without publishing a version or routing the domain', async () => {
    const calls: string[][] = [];
    const outputLines: string[] = [];
    let fetched = false;
    await runDeployment({
      dryRun: true,
      build: async () => {},
      smoke: async () => {},
      wrangler: async (args) => {
        calls.push(args);
        return 'dry run';
      },
      fetchBuild: async () => {
        fetched = true;
        return {};
      },
      print: (line) => outputLines.push(line),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).toContain('deploy');
    expect(calls[0]).not.toContain('versions');
    expect(calls[0]).not.toContain('triggers');
    expect(fetched).toBe(false);
    expect(outputLines.join('\n')).toContain('no version or domain changes');
  });

  test('failed build or smoke test never uploads', async () => {
    for (const failure of ['build', 'smoke'] as const) {
      const calls: string[] = [];
      await expect(
        runDeployment({
          dryRun: false,
          build: async () => {
            calls.push('build');
            if (failure === 'build') throw new Error('build failed');
          },
          smoke: async () => {
            calls.push('smoke');
            if (failure === 'smoke') throw new Error('smoke failed');
          },
          commit: 'a'.repeat(40),
          isTreeClean: async () => [],
          fetchBuild: async () => ({ commit: 'b'.repeat(40) }),
          wrangler: async () => {
            calls.push('upload');
            return '';
          },
          print: () => {},
        }),
      ).rejects.toThrow(`${failure} failed`);
      expect(calls).not.toContain('upload');
    }
  });
});

test('the build output is ignored by git', () => {
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
  expect(ignore).toMatch(/storybook-static/);
  const web = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(web.scripts['storybook:build']).toContain('scripts/storybook-build.ts');
  const configText = readFileSync(resolve(app, 'storybook.wrangler.jsonc'), 'utf8').replace(/,\s*([}\]])/g, '$1');
  const config = JSON.parse(configText) as {
    name: string;
    preview_urls: boolean;
    routes: { pattern: string; custom_domain: boolean }[];
    assets: { directory: string };
  };
  expect(config.name).toBe('rezics-storybook');
  expect(config.account_id).toBe('dcc939f004008f8e36e11456df3f0fe2');
  expect(config.preview_urls).toBe(true);
  expect(config.routes).toContainEqual({ pattern: 'storybook.rezics.com', custom_domain: true });
  expect(config.assets.directory).toBe('./storybook-static');
  expect(config.assets).not.toHaveProperty('binding');
  expect(config.assets).not.toHaveProperty('run_worker_first');
});

test('the installed Wrangler accepts the assets-only config in dry-run mode', () => {
  const result = Bun.spawnSync(
    ['./node_modules/.bin/wrangler', 'deploy', '--dry-run', '--config', 'storybook.wrangler.jsonc'],
    { cwd: app, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(`${result.stdout.toString()}\n${result.stderr.toString()}`).toContain('Total Upload');
  expect(result.exitCode).toBe(0);
});

test('deployment applies the custom domain and verifies the live build commit', async () => {
  const calls: string[][] = [];
  const outputLines: string[] = [];
  const expected = 'a'.repeat(40);
  let liveReads = 0;
  await runDeployment({
    dryRun: false,
    commit: expected,
    build: async () => {},
    smoke: async () => {},
    wrangler: async (args) => {
      calls.push(args);
      if (args[1] === 'upload') return 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev';
      return 'deployed';
    },
    fetchBuild: async () => ({ commit: ++liveReads === 1 ? 'b'.repeat(40) : expected }),
    isTreeClean: async () => [],
    print: (line) => outputLines.push(line),
  });
  expect(calls.map((args) => args.slice(0, 2))).toEqual([
    ['versions', 'upload'],
    ['versions', 'deploy'],
    ['triggers', 'deploy'],
  ]);
  expect(calls[1]).toContain('ver-123@100');
  expect(outputLines.join('\n')).toContain('https://ver-123.storybook.rezics.workers.dev');
  expect(liveReads).toBe(2);
});

test('deployment fails when the live domain serves a different commit', async () => {
  const calls: string[][] = [];
  await expect(
    runDeployment({
      dryRun: false,
      commit: 'a'.repeat(40),
      build: async () => {},
      smoke: async () => {},
      wrangler: async (args) => {
        calls.push(args);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      fetchBuild: async () => ({ commit: 'b'.repeat(40) }),
      isTreeClean: async () => [],
      print: () => {},
    }),
  ).rejects.toThrow(/live build.*commit/i);
  expect(calls.map((args) => args.slice(0, 2))).toEqual([
    ['versions', 'upload'],
    ['versions', 'deploy'],
    ['triggers', 'deploy'],
  ]);
});
