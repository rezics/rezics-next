import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createCommunityDeclaration } from '../../src/community/declaration.ts';
import { readPublication } from '../../src/community/publication.ts';
import { listRealmClaimRequests } from '../../src/community/realm-claim-review.ts';
import { ProblemError } from '../../src/http/problem.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

/** Any property read fails: a refusal must come from the supplied deadline capability alone. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('database or access touched before the deadline check');
    },
  },
);
const pool = untouchable as unknown as Pool;
const access = untouchable as unknown as Access;
const routeKey = new Uint8Array(32);
const clock = () => new Date('2026-11-06T00:00:00.000Z');

describe('Community ambient capability', () => {
  test('the declaration exposes the work module and viewer permissions built from its ambient', () => {
    const declaration = createCommunityDeclaration({ deadlineNow: () => 0 });

    expect(declaration.name).toBe('community');
    expect(declaration.work.name).toBe('community');
    expect(declaration.viewerResources.map(([type]) => type)).toEqual(['community.realm', 'community.space']);
  });

  test('a supplied deadline clock closes a publication read before any database access', async () => {
    const realmId = newId(1);
    const subjectId = newId(1);
    const deadline = Date.now() + 30_000;
    // Real time is still before the deadline; the supplied capability says it has passed.
    const deps = { pool, access, routeKey, clock, deadlineNow: () => deadline + 1 };

    await expect(
      readPublication(deps, realmId, subjectId, { actor: { kind: 'anonymous' }, deadline }),
    ).resolves.toBeNull();
  });

  test('a supplied deadline clock refuses a claim review before any database access', async () => {
    const realmId = newId(1);
    const deadline = Date.now() + 30_000;
    const actor = {
      kind: 'account',
      accountId: newId(1),
      clientId: 'ambient-test-client',
      requestedBy: 'ambient-test',
    } as unknown as Actor;
    const deps = { pool, access, clock, deadlineNow: () => deadline + 1 };

    const refused = listRealmClaimRequests(deps, actor, { realmId }, { deadline });
    await expect(refused).rejects.toBeInstanceOf(ProblemError);
    await expect(refused).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });
});
