import { expect, test } from 'bun:test';
import { createRealmRankOrderSource } from '../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { SubjectCanonicalNameKey } from '../../src/semantic/subject-source-key-pages.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

test('native canonical names seek across ties and missing names and bind committed population changes', async () => {
  const fixture = await createFigureFixture({ subjects: 4, partitions: 1 });
  try {
    await fixture.drain();
    const ids = [...fixture.subjectIds].sort();
    const partition = partitionOf(routeOf(ids[0]!)!);
    const context = () => ({ deadline: Date.now() + 30_000 });
    const source = subjectSource(fixture.database.pool);
    const rename = (id: string, name: string) =>
      fixture.database.admin.query(
        `INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,language,body,recorded_transaction_id)
       SELECT f.route,f.subject_id,f.slot_id,f.log_seq+1,'assert','label',f.language,to_jsonb($2::text),f.recorded_transaction_id
       FROM semantic.current_term_fact f WHERE f.route=$3 AND f.subject_id=$1 AND f.kind='label' AND f.language='en'
       ORDER BY f.log_seq DESC LIMIT 1`,
        [id, name, routeOf(id)],
      );
    await rename(ids[0]!, 'Zeta');
    await rename(ids[1]!, 'Alpha');
    await rename(ids[2]!, 'Alpha');
    await fixture.database.admin.query(
      `UPDATE semantic.term_head SET active=false WHERE route=$1 AND subject_id=$2 AND kind='label'`,
      [routeOf(ids[3]!), ids[3]],
    );
    const snapshot = await source.read(partition, ids);
    expect(snapshot.subjects.map(({ id, labels }) => [id, labels[0]?.value ?? null])).toEqual(
      ids.map((id, index) => [id, ['Zeta', 'Alpha', 'Alpha', null][index] ?? null]),
    );
    const observed = await source.canonicalNames.observe(context());
    expect(observed.homes.some((home) => home.partition === partition)).toBe(true);
    const keys: SubjectCanonicalNameKey[] = [];
    let after: SubjectCanonicalNameKey | null = null;
    for (;;) {
      const page = await source.canonicalNames.read({ partition, after, limit: 2 }, observed, context());
      expect(page.candidates.length).toBeLessThanOrEqual(2);
      if (page.candidates.length === 0) break;
      keys.push(...page.candidates);
      after = page.candidates.at(-1)!;
    }
    expect(keys.filter(({ id }) => ids.includes(id)).map(({ id }) => id)).toEqual([ids[1]!, ids[2]!, ids[0]!, ids[3]!]);
    expect(new Set(keys.map(({ id }) => id)).size).toBe(keys.length);
    const owner = observed.homes.find((home) => home.partition === partition)!;
    const writer = await fixture.database.admin.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE semantic.term_head SET active=false WHERE route=$1 AND subject_id=$2 AND kind='label'`,
        [routeOf(ids[1]!), ids[1]],
      );
      // A sequence increment is visible before commit; the native population generation must not be.
      expect(
        (await source.canonicalNames.observe(context())).homes.find((home) => home.partition === partition),
      ).toEqual(owner);
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await expect(source.canonicalNames.read({ partition, after, limit: 2 }, observed, context())).rejects.toMatchObject(
      { code: 'search_restart_required' },
    );

    const { system } = communityFixtureRuntime();
    const actor = await system.access.authenticate(fixture.realmMembers[0]!.bearer, {
      pool: fixture.database.pool,
      deadline: context().deadline,
    });
    const rank = createRealmRankOrderSource({
      pool: fixture.database.pool,
      access: system.access,
      tokens: system.tokenKeys,
    });
    const selected = { realmId: fixture.realmId, questionId: STANDARD_QUESTION_ID };
    const rankObservation = await rank.observe(actor, selected, context());
    expect(rankObservation.priorActive).toBe(false);
    const page = await rank.readCanonicalPartition(
      actor,
      { ...selected, partition, after: null, limit: 200 },
      rankObservation,
      context(),
    );
    expect(page.candidates.filter(({ id }) => ids.includes(id))).toHaveLength(4);
    expect(page.candidates.every(({ proof }) => !proof.scored && proof.figure === null)).toBe(true);
    await expect(
      rank.readCanonicalPartition(
        { ...actor, scopes: [] },
        {
          ...selected,
          partition,
          after: keys.at(-1)!,
          limit: 2,
        },
        rankObservation,
        context(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await rename(ids[0]!, 'Aardvark');
    await expect(
      rank.proveFigures(actor, { ...selected, partition, subjectIds: [] }, rankObservation, context()),
    ).rejects.toMatchObject({ code: 'search_restart_required' });
  } finally {
    await fixture.close();
  }
}, 600_000);
