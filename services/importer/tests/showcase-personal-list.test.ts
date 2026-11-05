import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import { readShowcasePersonalListExport, seedShowcasePersonalList } from '../src/showcase-personal-list.ts';

const identity = {
  origin: 'https://kernel.test',
  actor: { accountId: 'ordinary-person', clientId: 'showcase' },
  credential: { keyId: 'key-1' },
};
const tempRoot = join(import.meta.dir, '../../../.temp');

test('uploads through the generated VNDB route and resumes the exact private intent after unknown delivery', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'showcase-personal-list-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const calls: { path: string; key: string | null; body: string }[] = [];
  const firstId = '01900000-0000-4000-8000-000000000001';
  const changedId = '01900000-0000-4000-8000-000000000002';
  const xml =
    '<vndb-export version="1.0"><vns><vn id="v123"><title>Original</title></vn><vn id="v456" /></vns></vndb-export>';
  const changedXml = xml.replace('Original', 'Changed');
  const client = createKernelClient('https://kernel.test', {
    headers: { authorization: 'Bearer ordinary-person' },
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().text();
      calls.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body,
      });
      if (calls.length === 1) throw new TypeError('fetch failed');
      const source = JSON.parse(body) as { xml: string };
      return Response.json({ uploadId: source.xml === changedXml ? changedId : firstId, rows: 2, limits: {} });
    }) as typeof globalThis.fetch,
  });

  try {
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'unknown-delivery',
      code: 'http-503',
    });
    journal.close();
    journal = new ShowcaseJournal(path);
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, identity, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, identity, xml: changedXml })).toEqual({
      state: 'uploaded',
      uploadId: changedId,
      rows: 2,
    });

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.path)).toEqual(Array(4).fill('/v1/libraryImports/vndb:preview'));
    expect(calls.slice(0, 3).map((call) => call.key)).toEqual([calls[0]!.key, calls[0]!.key, calls[0]!.key]);
    expect(calls[3]!.key).not.toBe(calls[0]!.key);
    expect(calls.slice(0, 3).map((call) => JSON.parse(call.body))).toEqual(Array(3).fill({ xml }));
    expect(JSON.parse(calls[3]!.body)).toEqual({ xml: changedXml });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test('reopen preserves the original response, current authority and terminal refusals without changing private custody', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-custody-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const xml = '<vndb-export version="1.0"><vns><vn id="v4" /></vns></vndb-export>';
  const uploadId = '01900000-0000-4000-8000-000000000001';
  let calls = 0;
  let response = () => Response.json({ uploadId, rows: 1 });
  const client = createKernelClient(identity.origin, {
    fetch: (async (_input, _init) => {
      calls++;
      return response();
    }) as typeof fetch,
  });
  const run = (current = identity) => seedShowcasePersonalList({ client, journal, identity: current, xml });
  const reopen = () => {
    journal.close();
    journal = new ShowcaseJournal(path);
  };
  try {
    const acknowledge = journal.acknowledgeAction.bind(journal);
    let receiptKey = '';
    journal.acknowledgeAction = (key, id) => {
      if (key.endsWith(':response')) {
        receiptKey = key;
        throw new Error('Process stopped after recording the response');
      }
      acknowledge(key, id);
    };
    await expect(run()).rejects.toThrow('Process stopped after recording the response');
    reopen();
    expect(await run()).toEqual({ state: 'uploaded', uploadId, rows: 1 });
    expect(journal.action(receiptKey)?.state).toBe('acknowledged');
    reopen();
    for (const current of [
      { ...identity, origin: 'https://other.test' },
      { ...identity, actor: { ...identity.actor, accountId: 'other-person' } },
      { ...identity, actor: { ...identity.actor, clientId: 'other-client' } },
      { ...identity, credential: { keyId: 'other-key' } },
    ])
      expect(await run(current)).toEqual({ state: 'unavailable', code: 'sealed-identity-changed' });
    expect(calls).toBe(2);
    for (const body of [
      { uploadId, rows: 2 },
      { uploadId: '01900000-0000-4000-8000-000000000002', rows: 1 },
    ]) {
      response = () => Response.json(body);
      expect(await run()).toEqual({ state: 'unknown-delivery', code: 'upload-response-changed' });
    }
    response = () => Response.json({ uploadId, rows: 1 });
    expect(await run()).toEqual({ state: 'uploaded', uploadId, rows: 1 });
    for (const invalid of [
      () => Response.json({ uploadId, rows: 1 }, { status: 202 }),
      () => Response.json({ uploadId: 'not-a-uuid', rows: 1 }),
      () => Response.json({ uploadId, rows: 5001 }),
    ]) {
      response = invalid;
      expect(await run()).toEqual({ state: 'unknown-delivery', code: 'invalid-response' });
    }
    response = () => Response.json({ code: 'forbidden', detail: xml }, { status: 403 });
    expect(await run()).toEqual({ state: 'refused', code: 'http-403' });
    const sent = calls;
    reopen();
    expect(await run()).toEqual({ state: 'refused', code: 'http-403' });
    expect(calls).toBe(sent);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('private exports are bounded regular owner-only UTF-8 files; the native endpoint owns XML admission', async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'personal-list-input-'));
  const path = join(directory, 'export.xml');
  try {
    const xml = '<vndb-export version="1.0"><vns><vn id="v2002" /></vns></vndb-export>';
    await writeFile(path, xml, { mode: 0o600 });
    expect(await readShowcasePersonalListExport(path)).toBe(xml);
    await chmod(path, 0o644);
    await expect(readShowcasePersonalListExport(path)).rejects.toThrow('owner-only regular file');
    await chmod(path, 0o600);
    await symlink(path, join(directory, 'link.xml'));
    await expect(readShowcasePersonalListExport(join(directory, 'link.xml'))).rejects.toThrow();
    await expect(readShowcasePersonalListExport(directory)).rejects.toThrow('owner-only regular file');
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from([0xff])]) {
      await writeFile(path, bytes);
      await expect(readShowcasePersonalListExport(path)).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
