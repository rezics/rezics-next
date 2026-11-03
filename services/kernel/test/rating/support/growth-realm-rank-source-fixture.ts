import { resourceRoleCatalogue } from '../../../src/access/resource-roles.ts';
import { createRealmRankSource, type RealmRankRequest } from '../../../src/rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import type { Actor } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { communityFixtureRuntime } from '../../community/community-driver.ts';
import { settle } from '../../support/growth.ts';
import { createFigureFixture } from './figure-fixture.ts';

export const REALM_RANK_SCALES = [256, 1024, 4096] as const;
export const RANK_PAGE_SIZE = 64;
export type RankGrowthDimension = 'candidate depth' | 'question history' | 'subject and authority history';

/** Native authority and initial publication; bulk setup copies only production row shapes.
 * Rank and generation are maintained exclusively by the installed figure publication trigger.
 */
export async function createGrowthRealmRankSourceFixture() {
  const fixture = await createFigureFixture({ subjects: 12, partitions: 1 });
  try {
    const { system } = communityFixtureRuntime();
    for (const subject of fixture.subjectIds)
      for (const voter of fixture.realmMembers) await fixture.vote(subject, voter, 10);
    await fixture.drain();
    const { database } = fixture;
    const route = routeOf(fixture.subjectIds[0]!)!;
    const partition = partitionOf(route);
    const source = createRealmRankSource({ pool: database.pool, access: system.access, tokens: system.tokenKeys });
    const request: RealmRankRequest = {
      realmId: fixture.realmId,
      questionId: STANDARD_QUESTION_ID,
      partition,
      sort: 'score_desc',
      limit: RANK_PAGE_SIZE,
    };
    const roles = resourceRoleCatalogue(system.access)!;
    const grantRoles = (action: string) =>
      [...roles.roles.values()].filter((actions) => actions.includes(action)).length;
    // Derived before capture, with one human, one inverse Realm and no delegation.
    const realmRows = 186 + 20 * grantRoles('realm:read');
    const subjectRows = 165 + 20 * grantRoles('subject:read');
    const pageBound = (consumed: number) => ({
      rows: 8 + consumed + 2 * realmRows + consumed * subjectRows,
      statements: 37 + 9 * consumed,
    });
    const ids = [...fixture.subjectIds];
    let actor: Actor;
    let ordered: { id: string; score: string }[] = [];
    let cursors: { deep?: string; withheld?: string; terminal?: string } = {};
    const refresh = async () => {
      const credential = await system.auth.issue({
        accountId: fixture.realmMembers[0]!.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: system.auth.ordinaryScopes,
      });
      actor = await system.access.authenticate(credential.bearer, {
        pool: database.pool,
        deadline: Date.now() + 180_000,
      });
    };
    const page = (input: RealmRankRequest = request) => source.page(actor, input, { deadline: Date.now() + 120_000 });
    const template = fixture.subjectIds[0]!;

    async function grow(dimension: RankGrowthDimension, scale: number, previous: number) {
      if (dimension === 'candidate depth') {
        const added = Array.from({ length: scale - ids.length }, () => newId(route));
        if (added.length) {
          // Same fields as semantic/create-subject.sql and create-revision.sql, using a native release/source.
          await database.admin.query(
            `INSERT INTO semantic.subject
            (route,subject_id,type,recorded_transaction_id,current_facts,current_release)
            SELECT $1,id,s.type,id,s.current_facts,s.current_release FROM unnest($2::uuid[]) id
            CROSS JOIN semantic.subject s WHERE s.route=$1 AND s.subject_id=$3`,
            [route, added, template],
          );
          await database.admin.query(
            `INSERT INTO semantic.revision
            (route,subject_id,revision,kind,release,recorded_transaction_id,source)
            SELECT $1,id,1,'create',r.release,id,r.source FROM unnest($2::uuid[]) id
            CROSS JOIN semantic.revision r WHERE r.route=$1 AND r.subject_id=$3 AND r.revision=1`,
            [route, added, template],
          );
          // Finalized public-figure columns from the native drain. Never insert the rank projection directly.
          await database.admin.query(
            `INSERT INTO rating.public_figure
            (route,question_id,population_id,subject_id,count,mean,score,m,c,prior_epoch,revision,as_of,
             position,published_prior_generation)
            SELECT $1,f.question_id,f.population_id,id,f.count,f.mean,f.score,f.m,f.c,f.prior_epoch,
              f.revision,f.as_of,f.position,f.published_prior_generation
            FROM unnest($2::uuid[]) id CROSS JOIN rating.public_figure f
            WHERE f.route=$1 AND f.subject_id=$3 AND f.question_id=$4 AND f.population_id=$5`,
            [route, added, template, STANDARD_QUESTION_ID, fixture.realmId],
          );
          ids.push(...added);
        }
        // Two score tiers, with a strict deep page spanning their boundary and UUID ties in each tier.
        const sorted = [...ids].sort().reverse();
        await database.admin.query(
          `UPDATE rating.public_figure SET mean=CASE WHEN subject_id=ANY($4::uuid[]) THEN 10 ELSE 0 END,
          score=round((c*m + count*CASE WHEN subject_id=ANY($4::uuid[]) THEN 10 ELSE 0 END)/(c+count),4),
          revision=revision+1 WHERE route=$1 AND question_id=$2 AND population_id=$3`,
          [route, STANDARD_QUESTION_ID, fixture.realmId, sorted.slice(0, scale - 96)],
        );
      } else if (dimension === 'question history') {
        const questions = Array.from({ length: scale - previous }, () => newId(route));
        await database.admin.query(
          `INSERT INTO rating.question
          (id,owner_id,revision,label,grain,minimum_units,maximum_units,step_units)
          SELECT id,$2,1,'Unrelated rank question','work',0,20,1 FROM unnest($1::uuid[]) id`,
          [questions, fixture.realmMembers[0]!.id],
        );
        await database.admin.query(
          `INSERT INTO rating.public_figure
          (route,question_id,population_id,subject_id,count,mean,score,m,c,prior_epoch,revision,as_of,
           position,published_prior_generation)
          SELECT f.route,q,f.population_id,f.subject_id,f.count,f.mean,f.score,f.m,f.c,f.prior_epoch,
            f.revision,f.as_of,f.position,f.published_prior_generation
          FROM unnest($1::uuid[]) q CROSS JOIN rating.public_figure f
          WHERE f.route=$2 AND f.subject_id=$3 AND f.question_id=$4 AND f.population_id=$5`,
          [questions, route, template, STANDARD_QUESTION_ID, fixture.realmId],
        );
      } else {
        // Latest-revision seeks and exact current temporal ACL probes must ignore closed history.
        const targets = [ordered[0]!.id, ordered.at(-128)!.id, ordered.at(-64)!.id];
        await database.admin.query(
          `INSERT INTO semantic.revision
          (route,subject_id,revision,kind,release,recorded_transaction_id,source)
          SELECT $1,id,n+1,'propose',r.release,id,r.source FROM unnest($2::uuid[]) id
          CROSS JOIN generate_series($3::int,$4::int) n CROSS JOIN semantic.revision r
          WHERE r.route=$1 AND r.subject_id=$5 AND r.revision=1`,
          [route, targets, previous + 1, scale, template],
        );
        for (const id of [fixture.realmId, ...targets])
          await database.admin.query(
            `INSERT INTO access.resource_denial
            (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
            SELECT $1,$2,$3,'',$4,'resource',tstzrange(
              '2000-01-01'::timestamptz+n*interval '2 days',
              '2000-01-02'::timestamptz+n*interval '2 days','[)'),$5
            FROM generate_series($6::int,$7::int) n`,
            [
              routeOf(id),
              id,
              fixture.realmMembers[0]!.id,
              id === fixture.realmId ? 'realm:read' : 'subject:read',
              newId(route),
              previous + 1,
              scale,
            ],
          );
      }
      ordered = (
        await database.admin.query<{ id: string; score: string }>(
          `SELECT subject_id::text AS id,score::text
        FROM rating.realm_rank WHERE partition_no=$1 AND question_id=$2 AND population_id=$3
        ORDER BY score DESC,subject_id DESC`,
          [partition, STANDARD_QUESTION_ID, fixture.realmId],
        )
      ).rows;
      if (ordered.length !== ids.length) throw new Error('Rank publication did not retain every seeded figure');
      await database.admin.query(
        `UPDATE semantic.subject SET visibility=CASE WHEN subject_id=ANY($3::uuid[])
        THEN 'taken_down' ELSE 'visible' END,security_revision=security_revision+1
        WHERE route=$1 AND subject_id=ANY($2::uuid[])`,
        [route, ids, ordered.slice(-64).map(({ id }) => id)],
      );
      await settle(database);
      // All publication/generation changes and withholding settle BEFORE any cursor witness is minted.
      cursors = {};
      let cursor: string | undefined;
      for (let offset = 0; offset < ids.length; offset += RANK_PAGE_SIZE) {
        await refresh();
        if (offset === ids.length - 128) cursors.deep = cursor;
        if (offset === ids.length - 64) cursors.withheld = cursor;
        const result = await page({ ...request, ...(cursor ? { cursor } : {}) });
        if (!result.next) throw new Error('Full consumed batch lost its continuation');
        cursor = result.next;
      }
      cursors.terminal = cursor;
      await refresh();
      // Fixed native authority expansion; no fake memberships, reader or disclosure flags.
      const inverse = await database.admin.query(
        `SELECT 1 FROM access.membership_inverse
        WHERE account_id=$1`,
        [fixture.realmMembers[0]!.id],
      );
      if (inverse.rowCount !== 1) throw new Error('Expected exactly one native membership inverse');
    }

    async function planEvidence() {
      const generation = (
        await database.admin.query<{ generation: string }>(
          `SELECT generation::text
        FROM rating.population_prior_epoch WHERE route=$1 AND question_id=$2 AND population_id=$3`,
          [routeOf(fixture.realmId), STANDARD_QUESTION_ID, fixture.realmId],
        )
      ).rows[0]!.generation;
      const after = ordered.at(-129)!;
      const plans = [];
      for (const deep of [false, true]) {
        const result = await database.admin.query(
          `EXPLAIN (FORMAT JSON) SELECT subject_id::text AS "subjectId",
          count::text,mean::text,score::text,prior_epoch AS "priorEpoch",revision::text,as_of AS "asOf"
          FROM rating.realm_rank WHERE partition_no=$1 AND question_id=$2 AND population_id=$3 AND prior_generation=$4
          ${deep ? 'AND (score,subject_id)<($6::numeric,$7::uuid)' : ''}
          ORDER BY score DESC,subject_id DESC LIMIT $5`,
          [
            partition,
            STANDARD_QUESTION_ID,
            fixture.realmId,
            generation,
            RANK_PAGE_SIZE,
            ...(deep ? [after.score, after.id] : []),
          ],
        );
        plans.push(JSON.stringify(result.rows));
      }
      return plans;
    }
    return {
      database,
      grow,
      refresh,
      page,
      request,
      pageBound,
      planEvidence,
      close: fixture.close,
      get ordered() {
        return ordered;
      },
      get cursors() {
        return cursors;
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
