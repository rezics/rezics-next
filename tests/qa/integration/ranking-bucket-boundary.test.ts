import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { rankingBuckets, type RankingInterval } from '../../../services/main/src/modules/rankings/projection.ts';
import { personaNames, personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { realmSourceRankingAt } from '../support/realm-ranking-clock.ts';
import { publishClosureOriginals, type ClosureOriginal } from './outcomes/realm/closure-original-credit-setup.ts';

type Page = { bucket: string; items: { id: string; score: number }[]; nextCursor: string | null };
const intervals = ['day', 'week', 'month'] as const;

async function read(person: PersonaSession, realm: string, interval: RankingInterval, cursor?: string): Promise<Page> {
  const query = new URLSearchParams({ metric: 'reads', interval, limit: '1', ...(cursor ? { cursor } : {}) });
  const response = await person.main('GET', `/v1/realms/${realm.slice(-36)}/rankings?${query}`);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body) as Page;
}

async function population(sessions: PersonaSessions, interval: RankingInterval): Promise<string[][]> {
  const populations: string[][] = [];
  for (const name of personaNames) {
    const first = await read(sessions[name], sessions.realm, interval);
    const ids = first.items.map(item => item.id);
    if (first.nextCursor) {
      const second = await read(sessions[name], sessions.realm, interval, first.nextCursor);
      expect(second.nextCursor).toBeNull();
      ids.push(...second.items.map(item => item.id));
    }
    populations.push(ids.sort());
  }
  return populations;
}

test('retained ranking bucket time survives source reconstruction and refuses missing scores or admissions for all six personas', async () => {
  const source = await personaSessions('public', { rankingAt: realmSourceRankingAt });
  const pool = boundedPool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  let consumer: PersonaSessions | undefined;
  try {
    const originals: ClosureOriginal[] = [];
    await publishClosureOriginals(source, originals, `Bucketboundary${randomUUID().replaceAll('-', '')}`, 2);
    for (const original of originals) {
      const response = await source.owner.main('PUT', `/v1/works/${original.work.slice(-36)}/progress`, {
        actingSubject: source.owner.actingSubject, expectedVersion: 0, standing: 'started',
      });
      expect(response.status, await response.text()).toBe(200);
    }
    // Wait only for the actual source projection, never for a calendar boundary.
    const deadline = Date.now() + 20_000;
    let projected = 0;
    do {
      projected = Number((await pool.query<{ count: string }>(`SELECT count(*)::text FROM access.read_ranking_score
        WHERE metric='reads' AND work=ANY($1::text[])`, [originals.map(item => item.work)])).rows[0]!.count);
      if (projected === 6) break;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    expect(projected).toBe(6);
    const retained = retainPersonaRealm(source);
    await source.close();
    // The real wall clock is after all three source buckets. Reconstruction
    // consumes the retained timestamp, with ordinary live OAuth and authority.
    for (const interval of intervals) expect(rankingBuckets(new Date(), interval).current)
      .not.toBe(rankingBuckets(new Date(realmSourceRankingAt), interval).current);
    [consumer] = await restorePersonaRealms([retained], { rankingAt: realmSourceRankingAt });
    if (!consumer) throw new Error('Ranking consumer was not restored');
    const expected = originals.map(item => item.work).sort();
    const complete = (actual: string[][]) => expect(actual).toEqual(personaNames.map(() => expected));
    for (const interval of intervals) {
      const actual = await population(consumer, interval);
      console.info('Ranking boundary population', JSON.stringify({ interval, personas: [...personaNames],
        sizes: actual.map(ids => ids.length), sourceAt: realmSourceRankingAt, readAt: new Date().toISOString() }));
      complete(actual);
    }

    // Removing a real score also withdraws its admitted rows through the owner
    // trigger. Old or adjacent buckets must never substitute for that score.
    const missing = originals[0]!.work;
    const removed = await pool.query(`DELETE FROM access.read_ranking_score
      WHERE metric='reads' AND interval='day' AND work=$1 RETURNING *`, [missing]);
    expect(removed.rowCount).toBe(1);
    try {
      const actual = await population(consumer, 'day');
      expect(actual).toEqual(personaNames.map(() => expected.filter(work => work !== missing)));
      expect(() => complete(actual)).toThrow();
    } finally {
      await pool.query(`INSERT INTO access.read_ranking_score
        SELECT * FROM jsonb_populate_recordset(NULL::access.read_ranking_score, $1::jsonb)`, [JSON.stringify(removed.rows)]);
    }
    const admission = await pool.query(`DELETE FROM access.read_ranking_admitted
      WHERE metric='reads' AND interval='day' AND work=$1 AND context=$2 RETURNING *`, [missing, consumer.realm]);
    expect(admission.rowCount).toBe(1);
    try {
      const actual = await population(consumer, 'day');
      expect(actual).toEqual(personaNames.map(() => expected.filter(work => work !== missing)));
      expect(() => complete(actual)).toThrow();
    } finally {
      await pool.query(`INSERT INTO access.read_ranking_admitted
        SELECT * FROM jsonb_populate_recordset(NULL::access.read_ranking_admitted, $1::jsonb)`, [JSON.stringify(admission.rows)]);
    }
    console.info('Ranking boundary replay', JSON.stringify({ sourceAt: realmSourceRankingAt,
      readAt: new Date().toISOString(), personas: [...personaNames], sourceRows: projected,
      reconstructed: true, missingScoreRefused: true, missingAdmissionRefused: true }));
  } finally { await (consumer ?? source).close(); await pool.end(); }
}, 240_000);
