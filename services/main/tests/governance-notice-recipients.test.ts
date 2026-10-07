import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { prepareDecisionNotices, unrecordedReasons } from '../src/modules/governance/notices.ts';

const decision = '00000000-0000-4000-8000-000000000001';
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

test('affected notices resume every author, controller and steward page and mint one credential per principal', async () => {
  const job = {
    ordinal: 1,
    target: { owner: 'graph', resource: 'urn:rezics:work' },
    participant: 'author-a',
    phase: 'graph',
    after_subject: null as string | null,
    subject: null as string | null,
    after_principal: null as string | null,
  };
  const notices = new Set<string>();
  let credentials = 0;
  const controllerLookups: unknown[][] = [];
  const controllers: Record<string, string[]> = {
    'author-a': [uid(2), uid(3), uid(4)],
    'author-b': [uid(5)],
    steward: [uid(6), uid(3)],
  };
  const client = {
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('SELECT ordinal,target'))
        return { rows: job.phase === 'done' ? [] : [{ ...job }] };
      if (sql.includes('SELECT agent FROM access.work_maintainer'))
        return { rows: args[1] ? [] : [{ agent: 'steward' }] };
      if (sql.includes('SELECT principal_id AS id')) {
        controllerLookups.push(args);
        const ids = controllers[String(args[0])]!.filter(
          (id) => !args[1] || id > String(args[1]),
        ).sort();
        return { rows: ids.slice(0, Number(args[2])).map((id) => ({ id })) };
      }
      if (sql.includes('SELECT id FROM access.governance_report'))
        return { rows: [{ id: decision }] };
      if (sql.includes('SELECT 1 FROM access.safety_party_notice'))
        return { rowCount: notices.has(String(args[1])) ? 1 : 0 };
      if (sql.includes('INSERT INTO access.governance_case_credential')) credentials++;
      if (sql.includes('INSERT INTO access.safety_party_notice')) notices.add(String(args[2]));
      if (sql.includes('UPDATE access.safety_notice_job'))
        Object.assign(job, {
          phase: args[2],
          after_subject: args[3],
          subject: args[4],
          after_principal: args[5],
        });
      if (sql.includes('SELECT 1 FROM access.safety_notice_job'))
        return { rowCount: job.phase === 'done' ? 0 : 1 };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const effects = {
    participants: async (_target: unknown, after: string | null, limit: number) => {
      expect(limit).toBe(1);
      return ['author-a', 'author-b'].filter((author) => !after || author > after).slice(0, limit);
    },
  };
  let done = false;
  for (let step = 0; step < 10 && !done; step++) {
    const before = notices.size;
    done = await prepareDecisionNotices(client, decision, decision, unrecordedReasons, effects, 2);
    expect(notices.size - before).toBeLessThanOrEqual(2);
  }
  expect(done).toBe(true);
  expect(notices.size).toBe(5);
  expect(credentials).toBe(5);
  expect(controllerLookups.some((args) => args[0] === 'author-a' && args[1] === uid(3))).toBe(true);
  expect(controllerLookups.every((args) => args[2] === 2)).toBe(true);
  await prepareDecisionNotices(client, decision, decision, unrecordedReasons, effects, 2);
  expect(credentials).toBe(5);
});

test('graph discovery cannot silently skip parties when its owner is unavailable', async () => {
  const client = {
    query: async () => ({
      rows: [{ ordinal: 1, target: { owner: 'graph' }, phase: 'graph', subject: null }],
    }),
  } as unknown as PoolClient;
  await expect(
    prepareDecisionNotices(client, decision, decision, unrecordedReasons),
  ).rejects.toThrow('graph notice participants are unavailable');
});
