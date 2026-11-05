import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import { seedShowcasePersonalList } from '../src/showcase-personal-list.ts';

test('uploads through the generated VNDB route and resumes the exact private intent after unknown delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-personal-list-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const calls: { path: string; key: string | null; body: string }[] = [];
  const firstId = '01900000-0000-4000-8000-000000000001';
  const changedId = '01900000-0000-4000-8000-000000000002';
  const xml =
    '<vndb-export version="1.0"><vns><vn id="v123"><title>Original</title></vn><vn id="v456" /></vns></vndb-export>';
  const changedXml = xml.replace('Original', 'Changed');
  const client = createKernelClient('https://kernel.test', {
    headers: { authorization: 'Bearer ordinary-person' },
    fetch: async (input, init) => {
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
    },
  });

  try {
    expect(await seedShowcasePersonalList({ client, journal, xml })).toEqual({
      state: 'unknown-delivery',
      code: 'transport-unavailable',
    });
    expect(await seedShowcasePersonalList({ client, journal, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, xml })).toEqual({
      state: 'uploaded',
      uploadId: firstId,
      rows: 2,
    });
    expect(await seedShowcasePersonalList({ client, journal, xml: changedXml })).toEqual({
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
});
