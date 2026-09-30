import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFeed } from '../../../services/main/src/modules/feed/read.ts';
import { WorkReadMoved, WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';

test('G-593: All matches followed cards once and fences their inventory; Following keeps its cursor head', async () => {
  const home = await startHomeStack('g-593-follow-fence');
  const matches = home.deps.follows.matches.bind(home.deps.follows);
  try {
    const seeded = await seedHome(home);
    const request = new Request('http://main.local/v1/feed', {
      headers: { authorization: `Bearer ${home.reader.token}` } });
    const principal = await home.deps.account.verify(request);
    const checkpoint = await home.deps.feed.checkpoint(home.stack.env.lineage.dataEpoch);
    // Home hydrates public cards; the separate reader binds private preferences.
    const session = () => new WorkReadSession(home.deps, request, {},
      { dataEpoch: checkpoint.data_epoch, sequence: checkpoint.sequence });
    const reader = { principal, agent: seeded.reader };
    const calls: number[] = [];
    let changeDuringMatch = false;
    home.deps.follows.matches = async (...args) => {
      calls.push(args[2].length);
      const result = await matches(...args);
      if (changeDuringMatch && args[2].length) {
        await home.stack.accessPool.query('UPDATE access.follow_inventory SET revision = $2 WHERE principal_id = $1',
          [home.reader.principalId, randomUUID()]);
      }
      return result;
    };
    for (const sort of ['best', 'top'] as const) {
      calls.length = 0;
      const page = await readFeed(session(), { scope: 'all', sort }, reader);
      expect(page.items.length).toBeGreaterThanOrEqual(5);
      expect(page.items.some(item => item.reason.kind === 'followed'
        && [seeded.realm.realm, seeded.works[1]!.work].includes(item.reason.target))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBeGreaterThan(0);
      expect(calls[1]).toBe(0);
    }
    // A follow change after the card-match batch must never return stale reasons.
    changeDuringMatch = true;
    for (const scope of ['all', 'following'] as const) {
      calls.length = 0;
      await expect(readFeed(session(), { scope, sort: 'best' }, reader))
        .rejects.toBeInstanceOf(WorkReadMoved);
      expect(calls).toHaveLength(scope === 'all' ? 2 : 3);
      expect(calls.at(-1)).toBe(0);
    }
  } finally {
    home.deps.follows.matches = matches;
    await home.stop();
  }
}, 120_000);
