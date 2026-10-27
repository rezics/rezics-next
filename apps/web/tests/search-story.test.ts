import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { facetProperties, type FilterRelease } from '@rezics/filter';
import { bundledRelease } from '@rezics/definitions/bundled';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
const ui = join(root, 'packages/ui');
const recorded = join(app, 'src/kernel/recorded');
const timeout = 900_000;
const executable = (name: string) =>
  [app, ui].map((directory) => join(directory, 'node_modules/.bin', name)).find(existsSync)!;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;

type Labels = Record<string, string>;
type Release = { types: Record<string, { labels: Labels }>; properties: Record<string, { datatype: string }> };
const release = bundledRelease as unknown as Release;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function storybook(): Promise<string> {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child = spawn(executable('storybook'), ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
  });
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) })).ok) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${output}`);
    await Bun.sleep(500);
  }
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function openStory(file: string, visitor: string, locale: string): Promise<Page> {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === `${file}.stories.tsx` &&
      candidate.name === visitor,
  );
  if (!entry) throw new Error(`Missing ${file} story for ${visitor}.`);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return page;
}

async function subject() {
  const recording = (await Bun.file(join(recorded, 'subject.json')).json()) as {
    subject: {
      type: string;
      labels: Labels;
      descriptions: Labels;
      statements: Record<string, { value: { type: string; content: unknown } }[]>;
    };
    related: Record<string, { labels: Labels }>;
  };
  return recording;
}

/** The result row of the recorded subject: the list item that holds its link. */
function resultRow(page: Page, label: string) {
  return page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: label, exact: true }) });
}

test(
  "the search story shows each result's type name and description",
  async () => {
    const { subject: recorded } = await subject();
    const rawTypeName = release.types[recorded.type]?.labels.en;
    expect(rawTypeName, 'the recorded release names the recorded subject type').toBeTruthy();
    const typeName = `${rawTypeName![0]!.toLocaleUpperCase('en')}${rawTypeName!.slice(1)}`;
    expect(recorded.descriptions.en, 'the recorded subject has an English description').toBeTruthy();
    for (const visitor of ['Signed In', 'Signed Out']) {
      const page = await openStory('search', visitor, 'en');
      try {
        const row = resultRow(page, recorded.labels.en!);
        await row.waitFor({ timeout: 30_000 });
        await row.getByText(recorded.descriptions.en!, { exact: true }).waitFor({ timeout: 15_000 });
        await row.getByText(typeName!, { exact: true }).waitFor({ timeout: 15_000 });
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "the story of a search filtered to one type shows the result's leading facts",
  async () => {
    const { subject: recorded, related } = await subject();
    const properties = facetProperties(release as unknown as FilterRelease, [recorded.type])
      .filter((property) =>
        ['wikibase-item', 'time', 'quantity', 'string'].includes(release.properties[property]!.datatype),
      )
      .slice(0, 2);
    const facts = properties.flatMap((property) =>
      (recorded.statements[property] ?? []).flatMap(({ value }) => {
        if (value.type !== 'value') return [];
        if (typeof value.content === 'string') return [related[value.content]?.labels.en ?? value.content];
        const time = (value.content as { time?: string } | null)?.time;
        return time ? [String(Number(time.slice(0, 5)))] : [];
      }),
    );
    expect(facts.length, 'the recorded subject has a value for a leading facet of its type').toBeGreaterThan(0);
    for (const visitor of ['Signed In', 'Signed Out']) {
      const page = await openStory('search-typed', visitor, 'en');
      try {
        const row = resultRow(page, recorded.labels.en!);
        await row.waitFor({ timeout: 30_000 });
        await row.getByText(facts[0]!, { exact: true }).waitFor({ timeout: 15_000 });
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
