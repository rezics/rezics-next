import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { runDeployment, runStatus } from '../scripts/storybook-deploy.ts';
import { smokeStorybook } from '../scripts/storybook-smoke.ts';

const root = resolve(import.meta.dir, '../../../');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
const cloudflareOutput = resolve(app, '.cloudflare/output');
let browser: Browser;
let previewServer: ReturnType<typeof Bun.serve>;
let expectedCommit: string;

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
    const pages = Object.values(index.entries).filter(
      (entry) => entry.type === 'story' && entry.title.startsWith('Pages/'),
    );
    expect(pages.length).toBeGreaterThanOrEqual(countStories(resolve(app, 'src/stories')));
    expect(Object.values(index.entries).some((entry) => entry.title === 'Shell/Page heading')).toBe(false);
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
      build: async () => calls.push('build'),
      smoke: async () => calls.push('smoke'),
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
