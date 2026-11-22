import type { Instance, VisualNovelSubjectMatch } from '@rezics/launcher-contract';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sendAutomation } from './automation-transport';
import { createLauncherHost } from './host';

const website = 'https://rezics.example.test';
const endpoint = 'https://catalog.example.test';
const visualNovelType = 'wd:Q689445';
const id = (index: number) => `018943aa-abcd-4abc-9abc-${String(index).padStart(12, '0')}`;
const subject = (index: number) => ({
  id: id(index),
  type: visualNovelType,
  labels: { en: `Catalogue title ${index}` },
});

test('an agent can look up 100 local entries, review ambiguous results and apply the selected Subject IDs', async () => {
  const temporary = resolve(import.meta.dir, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'automation-vn-search-'));
  const dataDir = join(root, 'profile');
  const script = resolve(import.meta.dir, '../../scripts/host.ts');
  const input = join(root, 'request.json');
  const requests: string[] = [];
  let active = 0;
  let busiest = 0;
  let interrupted = 0;
  const waiting = Promise.withResolvers<void>();
  const requestsAborted = Promise.withResolvers<void>();
  const fetcher = (async (request, options) => {
    const url = new URL(String(request));
    expect(url.origin).toBe(endpoint);
    expect(new Headers(options?.headers).get('authorization')).toBeNull();
    if (options?.method === 'GET') {
      const subjectId = url.pathname.split('/').at(-1)!;
      requests.push(subjectId);
      const index = Number(subjectId.split('-').at(-1));
      expect(url.pathname).toBe(`/v1/subjects/${id(index)}`);
      return Response.json({ subject: subject(index) });
    }
    expect(url.pathname).toBe('/v1/subjects:search');
    const query = JSON.parse(String(options?.body));
    const title: string = query.text;
    expect(query).toMatchObject({ filter: { type: { in: [visualNovelType] } }, limit: 8 });
    expect(title).not.toContain(root);
    requests.push(title);
    active++;
    busiest = Math.max(busiest, active);
    try {
      if (title.startsWith('Pending ')) {
        const signal = options?.signal;
        if (!signal) throw new Error('A public search must have a cancellation signal.');
        await new Promise<never>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener(
            'abort',
            () => {
              if (++interrupted === 4) requestsAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
          if (active === 4) waiting.resolve();
        });
      }
      await Bun.sleep(2);
      if (title === 'Unavailable') return new Response(null, { status: 503 });
      if (title === 'Unknown') return Response.json({ subjects: [] });
      if (title === 'Ambiguous') return Response.json({ subjects: [subject(101), subject(2)] });
      const index = Number(title.match(/^Local title (\d+)$/)?.[1]);
      if (!Number.isInteger(index)) throw new Error(`Unexpected search title ${title}`);
      return Response.json({ subjects: [subject(index)] });
    } finally {
      active--;
    }
  }) as typeof fetch;
  let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;

  async function run(command: string, args: string[]) {
    const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(10_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  async function cli(command: string, value?: unknown[], expectedCode = 0) {
    if (value) await writeFile(input, JSON.stringify(value));
    const { code, stdout, stderr } = await run(command, value ? [input] : []);
    expect(code, stderr).toBe(expectedCode);
    return JSON.parse(stdout);
  }

  try {
    host = await createLauncherHost({
      dataDir,
      catalogUrl: endpoint,
      webUrl: website,
      launcherVersion: '0.1.0',
      openExternal: async () => {},
      automation: {},
      fetch: fetcher,
    });
    const imports = [];
    for (let index = 0; index < 100; index++) {
      const folder = join(root, 'games', String(index));
      const executable = join(folder, 'story.exe');
      await mkdir(join(folder, 'game'), { recursive: true });
      await writeFile(join(folder, 'game', 'options.rpy'), `define config.name = "Local title ${index}"\n`);
      await writeFile(executable, 'fixture');
      imports.push({ executable });
    }
    const installed: { status: string; instance: Instance }[] = await cli('import-vn', imports);
    expect(installed.filter(({ status }) => status === 'imported')).toHaveLength(100);
    const queries: unknown[] = [
      'Local title 0',
      ' Local title 0 ',
      'Ambiguous',
      'Unknown',
      'Unavailable',
      null,
      `${website}/en/subjects/${id(6)}/catalogue-title`,
      id(7),
      ...installed.slice(8).map(({ instance }) => instance.name),
    ];
    const results: { index: number; status: string; query?: string; matches?: VisualNovelSubjectMatch[] }[] = await cli(
      'search-vn-batch',
      queries,
      2,
    );
    expect(results.map(({ index }) => index)).toEqual(imports.map((_, index) => index));
    expect(results[0]).toMatchObject({ status: 'ready', matches: [{ id: id(0) }] });
    expect(results[1]).toEqual({ ...results[0]!, index: 1 });
    expect(requests.filter((request) => request === 'Local title 0')).toHaveLength(1);
    expect(results[2]?.matches?.map((match) => match.id)).toEqual([id(101), id(2)]);
    expect(results[3]).toMatchObject({ status: 'ready', matches: [] });
    expect(results[4]).toMatchObject({
      status: 'error',
      query: 'Unavailable',
      message: 'REZICS visual novel search is unavailable.',
    });
    expect(results[5]).toMatchObject({ status: 'error' });
    expect(results.slice(6).map((row) => row.matches?.[0]?.id)).toEqual(
      imports.slice(6).map((_, index) => id(index + 6)),
    );
    expect(busiest).toBe(4);
    const beforeLink: Instance[] = await cli('list-installed');
    expect(beforeLink.every((entry) => entry.subjectId === undefined)).toBe(true);

    const retry = (await cli('search-vn-batch', [id(3), id(4), id(5)])) as typeof results;
    const selected = [
      id(0),
      id(0),
      results[2]?.matches?.[1]?.id,
      ...retry.map((row) => row.matches?.[0]?.id),
      ...results.slice(6).map((row) => row.matches?.[0]?.id),
    ];
    const links = installed.map(({ instance }, index) => ({
      instanceId: instance.id,
      expectedSubjectId: null,
      subjectId: selected[index],
    }));
    expect((await cli('link-vn', links)).map((row: { status: string }) => row.status)).toEqual(
      Array(100).fill('changed'),
    );
    expect((await cli('link-vn', links)).map((row: { status: string }) => row.status)).toEqual(
      Array(100).fill('unchanged'),
    );

    const before = requests.length;
    await writeFile(input, JSON.stringify([...queries, 'Too many']));
    const oversized = await run('search-vn-batch', [input]);
    expect(oversized.code).toBe(1);
    expect(oversized.stderr).toContain('up to 100 visual novel queries');
    expect(requests).toHaveLength(before);

    const controller = new AbortController();
    const deadline = AbortSignal.timeout(5_000);
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
    });
    const search = sendAutomation(
      dataDir,
      {
        command: 'search-vn-batch',
        argument: Array.from({ length: 8 }, (_, index) => `Pending ${index}`),
      },
      AbortSignal.any([controller.signal, deadline]),
    );
    await Promise.race([waiting.promise, search, timeout]);
    controller.abort(new Error('Search interrupted by the agent.'));
    await expect(search).rejects.toThrow('Search interrupted by the agent.');
    await Promise.race([requestsAborted.promise, timeout]);
    expect(interrupted).toBe(4);
    expect(requests.slice(before)).toEqual(['Pending 0', 'Pending 1', 'Pending 2', 'Pending 3']);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
