import { expect, test } from 'bun:test';
import pg from 'pg';
import { matchesContentEditionBuyerFact, type ContentEditionBenefit } from '../../src/access/authenticated-benefit.ts';
import { AccessUnavailableError } from '../../src/request/unavailable.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../../src/command/command.ts';
import { createContentEditionBuyerFactReader } from '../../src/commerce/content-edition-buyer-fact.ts';
import type { CapturedContentEdition } from '../../src/commerce/model.ts';
import { withConnection } from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { newId } from '../../src/route/route.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');

test('Only an exact current native buyer entitlement yields the authenticated edition fact at the supplied live T and deadline while revoked unknown foreign unavailable facts cannot grant', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const route = 0x6e20;
  const sourceRoute = 0x6e40;
  const buyerAccountId = newId(route);
  const otherBuyer = newId(route);
  const foreignBuyer = newId(route + 16);
  const entitlementId = newId(route);
  const subjectId = newId(sourceRoute);
  const times: AuthoritativeTime[] = [];
  const benefit: ContentEditionBenefit = {
    kind: 'content-edition',
    resourceType: 'content.edition',
    action: 'edition:read',
    resource: { route: sourceRoute, id: newId(sourceRoute) },
    version: { revisionId: newId(sourceRoute), sha256: 'a'.repeat(64) },
  };
  const capture: CapturedContentEdition = {
    benefit,
    creatorAccountId: newId(sourceRoute),
    targetSubjectId: subjectId,
    source: { threadId: newId(sourceRoute), postId: newId(sourceRoute), licence: 'CC-BY-4.0' },
    saleTermsReference: 'native-fixed-edition-terms',
    delivery: 'fixed-content-edition',
    acquisition: 'one-time-account-bound',
    quantity: 1,
  };
  const read = createContentEditionBuyerFactReader({
    pool,
    clock: () => {
      throw new Error('The reader must use the supplied live T');
    },
  });
  async function liveTime() {
    const time = await withConnection(pool, (client) => mintReadTime(client));
    times.push(time);
    return time;
  }
  async function insert(id: string, captured: CapturedContentEdition | null, accountId = buyerAccountId) {
    await pool.query(
      `INSERT INTO commerce.entitlement
        (route,entitlement_id,account_id,order_id,offer_id,target_subject_id,granted_at,revision,transaction_id,content_edition)
       VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),7,$2,$7::jsonb)`,
      [
        route,
        id,
        accountId,
        newId(route),
        newId(sourceRoute),
        subjectId,
        captured === null ? null : JSON.stringify(captured),
      ],
    );
  }
  try {
    for (const [r, id] of [
      [route, buyerAccountId],
      [route, otherBuyer],
      [route + 16, foreignBuyer],
    ] as const)
      await pool.query(
        "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
        [r, id],
      );
    await insert(entitlementId, capture);
    const time = await liveTime();
    const deadline = Date.now() + 30_000;
    const input = { benefit, buyerAccountId, time, deadline };
    const fact = await read(input);
    expect(fact).not.toBeNull();
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.keys(fact!)).toEqual([]);
    expect(matchesContentEditionBuyerFact(fact, input)).toBe(true);
    // A second live object and an extended deadline cannot reuse this observation.
    const otherTime = await liveTime();
    expect(matchesContentEditionBuyerFact(fact, { ...input, time: otherTime })).toBe(false);
    expect(matchesContentEditionBuyerFact(fact, { ...input, deadline: deadline + 1 })).toBe(false);
    expect(matchesContentEditionBuyerFact({ ...fact }, input)).toBe(false);
    expect(matchesContentEditionBuyerFact(JSON.parse(JSON.stringify(fact)), input)).toBe(false);
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);

    expect(await read({ ...input, buyerAccountId: otherBuyer })).toBeNull();
    expect(await read({ ...input, buyerAccountId: foreignBuyer })).toBeNull();
    expect(
      await read({ ...input, benefit: { ...benefit, resource: { route: sourceRoute, id: newId(sourceRoute) } } }),
    ).toBeNull();
    expect(
      await read({
        ...input,
        benefit: { ...benefit, version: { ...benefit.version, revisionId: newId(sourceRoute) } },
      }),
    ).toBeNull();
    expect(
      await read({ ...input, benefit: { ...benefit, version: { ...benefit.version, sha256: 'b'.repeat(64) } } }),
    ).toBeNull();

    await pool.query(
      "UPDATE commerce.entitlement SET revoked_at=clock_timestamp(),revoke_reason='refund',revision=revision+1 WHERE route=$1 AND entitlement_id=$2",
      [route, entitlementId],
    );
    // Even this same live T is re-read, never served from an earlier fact/cache.
    expect(await read(input)).toBeNull();
    const unknownId = newId(route);
    await insert(unknownId, null);
    expect(await read(input)).toBeNull();

    const matchingId = newId(route);
    await insert(matchingId, capture);
    const current = { ...input, time: await liveTime() };
    expect(matchesContentEditionBuyerFact(await read(current), current)).toBe(true);
    const duplicateId = newId(route);
    await insert(duplicateId, capture);
    await expect(read({ ...current, time: await liveTime() })).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
    await pool.query('DELETE FROM commerce.entitlement WHERE route=$1 AND entitlement_id=$2', [route, duplicateId]);

    await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
      route,
      buyerAccountId,
    ]);
    await expect(read(current)).rejects.toBeInstanceOf(ProblemError);
    await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
      route,
      buyerAccountId,
    ]);
    await expect(read({ ...current, buyerAccountId: newId(route) })).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
    await expect(read({ ...current, deadline: Date.now() - 1 })).rejects.toBeInstanceOf(AccessUnavailableError);
    await expect(read({ ...current, deadline: Number.NaN })).rejects.toBeInstanceOf(TypeError);
    await expect(read({ ...current, time: {} as AuthoritativeTime })).rejects.toBeInstanceOf(TypeError);
    await expect(
      read({ ...current, benefit: { ...benefit, resource: { ...benefit.resource, route: route } } }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      read({ ...current, benefit: { ...benefit, version: { ...benefit.version, sha256: 'A'.repeat(64) } } }),
    ).rejects.toBeInstanceOf(TypeError);
    releaseOperationalTime(current.time);
    expect(matchesContentEditionBuyerFact(fact, { ...input, time: current.time })).toBe(false);
    await expect(read(current)).rejects.toBeInstanceOf(TypeError);
    expect(pool.idleCount).toBe(1);

    // The capture writer accepts the DTO shape; a malformed native source tuple is unavailable.
    await pool.query('DELETE FROM commerce.entitlement WHERE route=$1 AND entitlement_id=$2', [route, matchingId]);
    await insert(newId(route), { ...capture, source: { ...capture.source, postId: newId(route) } });
    await expect(read({ ...input, time: await liveTime() })).rejects.toMatchObject({ code: 'dependency_unavailable' });
  } finally {
    for (const time of times) releaseOperationalTime(time);
    await pool.query('DELETE FROM commerce.entitlement WHERE route=$1 AND account_id=$2', [route, buyerAccountId]);
    await pool.end();
  }
});
