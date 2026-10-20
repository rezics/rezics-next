import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { readRatingAggregateInventory } from '../../../services/main/src/modules/rating/aggregate-inventory.ts';
import { refreshStandingRatingProjections } from '../../../services/main/src/modules/rating/standing-publication.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

type Stack = Awaited<ReturnType<typeof startMediaStack>>;
type Person = Awaited<ReturnType<Stack['member']>>;
type Target = { work: string; mainVersion: string };
type Opinion = { observationRevision: string };
type Aggregate = { complete: true; population: number; count: number; withdrawnCount: number; sum: number; mean: number | null };

/** Real HTTP composition, graph commands/receipts/manifests and native owner
 * continuations. Account bearers are fixture identities, as in media-support;
 * this mechanism regression does not substitute for the retained genuine-corpus
 * assertions or their original-baseline and backup/restore prerequisites. */
test('standing publication isolates interrupted identity and projection cuts at 100/101/102 and preserves surviving histories', async () => {
  const preparation = Date.now();
  const f = await startMediaStack('standing-availability', { profileCredits: true });
  try {
    const owner = await f.member('owner', { verified: true }), first = await f.member('first', { verified: true }),
      second = await f.member('second', { verified: true });
    const reviewers = [owner, first, second];
    for (const person of reviewers) await person.grant(`agent:self:${person.actor}`, 'agent.control');
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const body = await response.text();
      if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
      return JSON.parse(body) as T;
    };
    const call = (person: Person | null, path: string, body: object, key = randomUUID()) => f.call('POST', path,
      { ...(person ? { token: person.token } : {}), key, body: { ...body, ...(person ? { actingSubject: person.actor } : {}) } });
    await owner.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const globalContext = (await json<{ context: string }>(await call(owner, '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Original contribution quality' }), 201)).context;
    const cleanContext = (await json<{ context: string }>(await call(owner, '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Independent current question' }), 201)).context;
    await owner.grant('space:create:root', 'space.create');
    const realm = (await json<{ realm: string }>(await call(owner, '/v1/spaces', { profile: 'space-realm-v1',
      name: `Standing comparison ${randomUUID()}`, language: 'en', capabilities: ['realm'] }), 201)).realm;
    await owner.grant(`rating:context:${realm}`, 'rating.context.create');
    const realmContext = (await json<{ context: string }>(await call(owner, '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm, question: 'Community contribution quality' }), 201)).context;
    const source = await f.publicWork(owner.actor, ['en'], 'Original standing source');
    const retained = [];
    for (let n = 0; n < 3; n++) retained.push(await f.publicWork(owner.actor, ['en'], `Retained standing target ${n}`));
    // The terminal target is beyond both the trigger's first projection and a
    // one-item continuation, so an interrupted page cannot accidentally test an
    // already current first-page sample.
    retained.sort((a, b) => a.mainVersion.localeCompare(b.mainVersion));
    const middle = retained[0]!, later = retained[1]!, target = retained[2]!;
    const unrelated = await f.publicWork(owner.actor, ['en'], 'Independent public standing target');
    for (const person of reviewers) for (const work of [source, middle, later, target]) {
      for (const action of ['work.read', 'work.review', 'work.edit'] as const) {
        await person.grant(`work:${action.slice(5)}:${work.work}`, action);
      }
    }
    const granted = new Set<string>();
    const rate = async (person: Person, context: string, work: Target, value: number | null, head: string | null = null) => {
      const key = `${person.principalId}:${context}`;
      if (!granted.has(key)) { await person.grant(`rating:observe:${context}`, 'rating.observation.set'); granted.add(key); }
      const global = context !== realmContext;
      return json<Opinion>(await call(person, global ? '/v1/global-rating-observations' : '/v1/rating-observations', {
        profile: global ? 'global-rating-standing-observation-v1' : 'realm-standing-rating-observation-v1',
        context, work: work.work, mainVersion: work.mainVersion, value, expectedRevisionHead: head }), 201);
    };
    const read = (context = globalContext, work: Target = target) => call(null,
      context === realmContext ? '/v1/rating-aggregates' : '/v1/global-rating-aggregates', {
        profile: context === realmContext ? 'realm-standing-latest-mean-v1' : 'global-rating-standing-latest-mean-v1',
        context, work: work.work, mainVersion: work.mainVersion });
    const available = async (context = globalContext, work: Target = target) => json<Aggregate>(await read(context, work));
    const prepare = async (a: Target, b: Target, original?: string) => {
      const rows = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        VALUES ?work { ${iri(a.work)} ${iri(b.work)} } ?work rv:head ?head } }`)).results!.bindings;
      const pin = (work: Target) => ({ resource: work.work, revision: rows.find(row => row.work!.value === work.work)!.head!.value });
      const evidence = [{ ...pin(a), locator: 'Fixture identity reconciliation' }];
      const candidate = { operation: original ? 'unmerge' : 'merge', source: pin(a), survivor: pin(b), evidence,
        ...(original ? { original } : {}) };
      const proposed = await json<{ proposal: string }>(await call(owner, '/v1/editorial/proposals', {
        profile: 'editorial-proposal-create-v1', kind: 'merge', target: { ...pin(a), context: 'urn:rezics:context:global' },
        candidate, baseHeads: rows.map(row => ({ component: row.work!.value, head: row.head!.value })), evidence }), 201);
      for (const reviewer of [first, second]) await json(await call(reviewer,
        `/v1/editorial/proposals/${proposed.proposal}/reviews`, { profile: 'editorial-proposal-review-v1', revision: 1,
          outcome: 'approve', message: 'Reviewed both fixture identities and retained histories' }));
      const key = randomUUID(), task = `editorial:${proposed.proposal}:1`;
      const advance = async () => {
        const response = await call(second, `/v1/editorial/proposals/${proposed.proposal}/decisions`, {
          profile: 'editorial-proposal-decide-v1', revision: 1, outcome: 'applied', approve: false,
          message: 'Apply the reviewed identity reconciliation' }, key);
        expect([200, 202]).toContain(response.status);
        const result = await json<{ outcome: string }>(response, response.status);
        return result.outcome === 'applied';
      };
      const finish = async () => {
        for (let n = 0; n < 32; n++) if (await advance()) return;
        throw new Error('Identity task did not exhaust its bounded continuations');
      };
      const interrupt = async () => {
        for (let n = 0; n < 32; n++) {
          const done = await advance();
          const pending = (await f.accessPool.query(`SELECT 1 FROM access.rating_standing_transition t
            WHERE t.task_key=$1 AND NOT t.finished AND (${original ? `EXISTS (SELECT 1 FROM access.identity_merge_item_outcome o
              WHERE o.task_key=$1 AND o.owner='rating')` : `EXISTS (SELECT 1 FROM access.rating_merge_selection s
              WHERE s.task_key=$1)`})`, [task])).rowCount;
          if (pending) return;
          if (done) throw new Error('The intended interruption did not reach a pending owner page');
        }
        throw new Error('The intended interruption did not reach rating reconciliation');
      };
      return { task, finish, interrupt };
    };
    const origin = new Map<string, Opinion>();
    for (const person of [owner, first]) for (const context of [globalContext, realmContext]) {
      origin.set(`${person.principalId}:${context}`, await rate(person, context, source, context === globalContext ? 5 : 10));
    }
    await rate(owner, globalContext, unrelated, 5);
    await rate(owner, realmContext, unrelated, 10);
    await rate(owner, cleanContext, target, 4);
    const assertUnrelated = async () => {
      expect(await available(globalContext, unrelated)).toMatchObject({ complete: true, population: 1, count: 1, sum: 5 });
      expect(await available(realmContext, unrelated)).toMatchObject({ count: 1, sum: 10 });
      expect(await available(cleanContext)).toMatchObject({ population: 1, count: 1, sum: 4 });
    };
    const ab = await prepare(source, middle); await ab.finish();
    // One person replaces the inherited origin with a native vote. The next
    // merge carries two different ancestry paths under the same task/context.
    for (const context of [globalContext, realmContext]) origin.set(`${first.principalId}:${context}`,
      await rate(first, context, middle, context === globalContext ? 3 : 6));
    // Retain a valid direct-unmerge proposal before the later merges. Its
    // eventual delivery must honor old snapshots and revoke only their lineage.
    const undoAB = await prepare(source, middle, ab.task);
    const bc = await prepare(middle, later); await bc.finish();
    const cd = await prepare(later, target); await cd.interrupt();
    expect((await read()).status).toBe(503);
    expect((await read(realmContext)).status).toBe(503);
    await assertUnrelated();
    // Revoke a contribution whose two Context items were already delivered;
    // the other person's pending item CAS remains unchanged.
    const delivered = (await f.accessPool.query(`SELECT principal_id::text FROM access.rating_merge_selection
      WHERE task_key=$1 AND context=$2 ORDER BY principal_id LIMIT 1`, [cd.task, globalContext])).rows[0].principal_id;
    const revoked = delivered === owner.principalId ? owner : first, revokedOrigin = revoked === owner ? source : middle;
    for (const context of [globalContext, realmContext]) origin.set(`${revoked.principalId}:${context}`,
      await rate(revoked, context, revokedOrigin, null, origin.get(`${revoked.principalId}:${context}`)!.observationRevision));
    await cd.finish();
    const exhaust = async (context: string) => {
      for (let n = 0; n < 16; n++) if ((await refreshStandingRatingProjections(f.accessPool, { context, limit: 1 })).complete) return;
      throw new Error('Projection continuation did not exhaust its bounded pages');
    };
    for (const context of [globalContext, realmContext]) await exhaust(context);
    expect(await available()).toMatchObject({ population: 2, count: 1, withdrawnCount: 1 });
    await assertUnrelated();
    const activeGlobal = revoked === owner ? 3 : 5, activeRealm = revoked === owner ? 6 : 10;
    for (let n = 1; n <= 100; n++) {
      const person = await f.member(`native-rater-${n}`, { verified: true });
      await person.grant(`agent:self:${person.actor}`, 'agent.control');
      for (const context of [globalContext, realmContext]) await rate(person, context, target, 1);
      if (n >= 98) {
        expect(await available()).toMatchObject({ complete: true, population: n + 2, count: n + 1,
          withdrawnCount: 1, sum: n + activeGlobal });
        expect(await available(realmContext)).toMatchObject({ population: n + 2, count: n + 1, sum: n + activeRealm });
      }
    }
    expect(Date.now() - preparation).toBeLessThan(600_000);
    expect((await readRatingAggregateInventory(f.accessPool, globalContext, target.mainVersion)).standing!.witness!.mainVersion)
      .toBe(target.mainVersion); // surviving native witness at 102

    // An origin has three retained targets. Interrupt after the trigger and one
    // explicit page; the terminal target must remain held, with its other
    // Context and the unrelated public target still available.
    let ownerHead = origin.get(`${owner.principalId}:${globalContext}`)!;
    ownerHead = await rate(owner, globalContext, source, 4, ownerHead.observationRevision);
    expect(await refreshStandingRatingProjections(f.accessPool, { context: globalContext, limit: 1 }))
      .toMatchObject({ refreshed: 1, complete: false });
    expect((await read()).status).toBe(503);
    expect(await available(realmContext)).toMatchObject({ population: 102, count: 101, sum: 100 + activeRealm });
    await assertUnrelated();
    ownerHead = await rate(owner, globalContext, source, null, ownerHead.observationRevision); // rewind pending work
    const abort = new AbortController(); abort.abort();
    await expect(refreshStandingRatingProjections(f.accessPool, { context: globalContext, limit: 1 }, abort.signal)).rejects.toThrow();
    expect((await read()).status).toBe(503);
    await exhaust(globalContext);
    const bValue = revoked === first ? 0 : 3;
    expect(await available()).toMatchObject({ complete: true, population: 102, count: revoked === first ? 100 : 101,
      withdrawnCount: revoked === first ? 2 : 1, sum: 100 + bValue });
    expect((await readRatingAggregateInventory(f.accessPool, globalContext, target.mainVersion)).standing!.witness!.mainVersion)
      .toBe(source.mainVersion); // inherited witness verifies the same exact component

    // Interrupted ancestor unmerge cannot be attested by either witness. Once
    // its native pair is complete, descendants still wait for their own bounded
    // cleanup. The different person's native B lineage must survive throughout.
    await undoAB.interrupt();
    expect((await read()).status).toBe(503);
    await assertUnrelated();
    await undoAB.finish();
    expect((await read()).status).toBe(503);
    expect(await refreshStandingRatingProjections(f.accessPool, { context: globalContext, limit: 1 }))
      .toMatchObject({ refreshed: 1, complete: false });
    expect((await read()).status).toBe(503);
    await assertUnrelated();
    for (const context of [globalContext, realmContext]) await exhaust(context);
    expect(await available()).toMatchObject({ complete: true, population: 101, count: revoked === first ? 100 : 101,
      withdrawnCount: revoked === first ? 1 : 0, sum: 100 + bValue });
    expect(await available(realmContext)).toMatchObject({ population: 101, count: revoked === first ? 100 : 101,
      sum: 100 + (revoked === first ? 0 : 6) });

    // Removing the terminal merge leaves the 100 native votes immediately
    // usable. No unrelated mutation or global publication CLI is required.
    const undoCD = await prepare(later, target, cd.task); await undoCD.finish();
    expect(await available()).toMatchObject({ complete: true, population: 100, count: 100, sum: 100, mean: 1 });
    expect(await available(realmContext)).toMatchObject({ population: 100, count: 100, sum: 100, mean: 1 });
    await assertUnrelated();

    // Count every statement, including transaction control, at the unchanged
    // owner boundary used by the retained synthesis cost assertion.
    let statements = 0;
    const measured = { async connect() {
      const client = await f.accessPool.connect();
      return { query: (...args: Parameters<typeof client.query>) => { statements++; return client.query(...args); },
        release: (destroy?: boolean) => client.release(destroy) };
    } } as unknown as Pool;
    const reader = createMainApp(f.fuseki, { environment: f.env, account: f.composition.dependencies.account,
      access: new AccessAdmissionRegistry(measured) });
    const synthesis = await json<{ status: string; components: { global: Aggregate; realm: Aggregate } }>(await reader.handle(
      new Request('http://main.local/v1/rating-syntheses', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'realm-global-standing-synthesis-v1', realmContext, globalContext,
          work: target.work, mainVersion: target.mainVersion }) })));
    expect(synthesis).toMatchObject({ status: 'complete', components: { global: { population: 100, count: 100 },
      realm: { population: 100, count: 100 } } });
    expect(statements).toBe(9);
  } finally { await f.stop(); }
}, 600_000);
