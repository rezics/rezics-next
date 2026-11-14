import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createStorybookArtifactStore,
  storybookArtifactIdentity,
  type StorybookBuildMode,
} from '../scripts/storybook-artifact.ts';

const root = resolve(import.meta.dir, '../..');

function temporaryStore(): { directory: string; store: ReturnType<typeof createStorybookArtifactStore> } {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/storybook-artifact-test-'));
  return { directory, store: createStorybookArtifactStore(join(directory, 'artifacts')) };
}

function identity(source: string, mode: StorybookBuildMode = 'screenshot-test'): string {
  return storybookArtifactIdentity({
    mode,
    files: [
      { path: 'apps/web/src/stories/example.stories.tsx', contents: source },
      { path: 'apps/web/src/kernel/recorded/example.json', contents: '{"answer":1}' },
    ],
    configuration: { theme: 'static' },
  });
}

async function writeSite(site: string, mode: StorybookBuildMode = 'screenshot-test'): Promise<void> {
  await mkdir(site, { recursive: true });
  await writeFile(join(site, 'index.json'), '{"entries":{}}');
  await writeFile(join(site, 'iframe.html'), 'storybook');
  if (mode === 'full') {
    await mkdir(join(site, 'ui'), { recursive: true });
    await writeFile(join(site, 'ui', 'index.json'), '{"entries":{}}');
  }
}

test('same-key captures coalesce one build, reuse its bytes and retain the immutable result', async () => {
  const temporary = temporaryStore();
  let builds = 0;
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolveStarted) => (start = resolveStarted));
  const gate = new Promise<void>((resolveBuild) => (finish = resolveBuild));
  try {
    const key = identity('export const Example = () => null;');
    const build = async (site: string) => {
      builds += 1;
      start();
      await gate;
      await writeSite(site);
      return { nestedBuilds: 1 };
    };
    const firstRequest = temporary.store.acquire(key, build, { mode: 'screenshot-test' });
    await started;
    const secondRequest = temporary.store.acquire(key, build, { mode: 'screenshot-test' });
    finish();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(builds).toBe(1);
    expect(first.identity).toBe(key);
    expect(second.identity).toBe(key);
    expect(first.site).toBe(second.site);
    expect([first.disposition, second.disposition].sort()).toEqual(['built', 'reused']);
    expect(first.bytes).toBeGreaterThan(0);
    await first.release();
    await second.release();

    const again = await temporary.store.acquire(key, build, { mode: 'screenshot-test' });
    expect(again.disposition).toBe('reused');
    expect(builds).toBe(1);
    await again.release();
    expect(await Bun.file(join(temporary.directory, 'artifacts', key, 'site', 'index.json')).exists()).toBe(true);
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('effective source, recorded response and build mode changes select a new artifact identity', async () => {
  const temporary = temporaryStore();
  let builds = 0;
  try {
    const firstKey = identity('export const Example = () => null;');
    const changedSource = identity('export const Example = () => <main />;');
    const changedMode = identity('export const Example = () => null;', 'full');
    expect(changedSource).not.toBe(firstKey);
    expect(changedMode).not.toBe(firstKey);

    for (const [key, mode] of [
      [firstKey, 'screenshot-test'],
      [changedSource, 'screenshot-test'],
      [changedMode, 'full'],
    ] as const) {
      const artifact = await temporary.store.acquire(
        key,
        async (site) => {
          builds += 1;
          await writeSite(site, mode);
          return { nestedBuilds: mode === 'full' ? 2 : 1 };
        },
        { mode },
      );
      await artifact.release();
    }
    expect(builds).toBe(3);
    expect(
      readdirSync(join(temporary.directory, 'artifacts')).filter((entry) => /^[a-f0-9]{64}$/.test(entry)),
    ).toHaveLength(2);
    const recordedChange = storybookArtifactIdentity({
      mode: 'screenshot-test',
      files: [
        { path: 'apps/web/src/stories/example.stories.tsx', contents: 'export const Example = () => null;' },
        { path: 'apps/web/src/kernel/recorded/example.json', contents: '{"answer":2}' },
      ],
      configuration: { theme: 'static' },
    });
    expect(recordedChange).not.toBe(firstKey);
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('a failed construction removes its reservation so the next request can recover', async () => {
  const temporary = temporaryStore();
  const key = identity('export const Example = () => null;');
  let builds = 0;
  try {
    await expect(
      temporary.store.acquire(
        key,
        async () => {
          builds += 1;
          throw new Error('interrupted build');
        },
        { mode: 'screenshot-test' },
      ),
    ).rejects.toThrow('interrupted build');

    const recovered = await temporary.store.acquire(
      key,
      async (site) => {
        builds += 1;
        await writeSite(site);
      },
      { mode: 'screenshot-test' },
    );
    expect(recovered.disposition).toBe('built');
    expect(builds).toBe(2);
    await recovered.release();
    expect((await Bun.file(join(temporary.directory, 'artifacts', key, 'artifact.json')).json()).identity).toBe(key);
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});
