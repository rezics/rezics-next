import { expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, openJournal } from '../bootstrap/journal.ts';
import type { BootstrapApi } from '../bootstrap/api.ts';

test('G-724 durable write-ahead journal survives interruption and refuses a changed plan, actor or intent', async () => {
  const folder = resolve(
    import.meta.dir,
    '../../../.temp/bootstrap',
    `journal-${crypto.randomUUID()}`,
  );
  const file = `${folder}/journal.json`,
    plan = digest('plan'),
    actor = 'original-actor';
  const body = { expectedHead: 'captured-head', candidateReceipt: 'captured-search' };
  const calls: unknown[] = [];
  let interrupted = true;
  const api: BootstrapApi = {
    read: async <T>() => ({}) as T,
    write: async <T>(_method: 'POST' | 'PUT', _path: string, submitted: unknown, key: string) => {
      const stored = JSON.parse(await readFile(file, 'utf8')) as {
        entries: Record<string, { body: unknown }>;
      };
      expect(stored.entries[key]!.body).toEqual(body);
      calls.push(submitted);
      if (interrupted) {
        interrupted = false;
        throw new Error('Network response lost');
      }
      return { receipt: 'owner-confirmed' } as T;
    },
  };
  try {
    const first = await openJournal(file, plan, actor);
    await expect(
      first.command(api, 'stable', 'POST', '/v1/works', body, 'same-intent'),
    ).rejects.toThrow('lost');
    const resumed = await openJournal(file, plan, actor);
    expect(
      await resumed.command<{ receipt: string }>(
        api,
        'stable',
        'POST',
        '/v1/works',
        { expectedHead: 'new-head', candidateReceipt: 'new-search' },
        'same-intent',
      ),
    ).toEqual({ receipt: 'owner-confirmed' });
    expect(calls).toEqual([body, body]);
    const replay = await openJournal(file, plan, actor);
    await replay.command(api, 'stable', 'POST', '/v1/works', body, 'same-intent');
    expect(calls).toHaveLength(2);
    await expect(openJournal(file, digest('changed-plan'), actor)).rejects.toThrow('another plan');
    await expect(openJournal(file, plan, 'other-actor')).rejects.toThrow('another plan');
    await expect(
      replay.command(api, 'stable', 'POST', '/v1/works', body, 'changed-intent'),
    ).rejects.toThrow('changed its intent');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
