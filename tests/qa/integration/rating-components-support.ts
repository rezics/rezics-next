import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { startMediaStack } from './media-support.ts';

type Stack = Awaited<ReturnType<typeof startMediaStack>>;
export type Person = Awaited<ReturnType<Stack['member']>>;
export interface Opinion { observation: string; observationRevision: string; value: number | null }
export interface Aggregate { count: number; population: number; withdrawnCount: number; sum: number;
  contextRevision: string;
  lastAdmissionId: string | null;
  sourcePosition: { dataEpoch: string; sequence: string };
  mean: number | null; meanDisplay: string; displayThreshold: number; histogram: number[];
  precision: { kind: string } }
export const short = (value: string) => value.slice(-36);

/** A real Main app over a disposable stack, with every rater a distinct Account principal. */
export async function startRatingStack(label: string) {
  const stack = await startMediaStack(label, { profileCredits: true });
  const people = new Map<string, Person>();
  const account = { verify: async (request: Request) => {
    const person = people.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!person) throw new AccountAssertionDenied();
    const principal = { ...person.principal, emailVerified: true };
    return { ...principal, currentAssertion: async () => principal };
  } };
  stack.access.configureBaseline(stack.fuseki);
  // Cost is counted where the owners are reached: graph queries and Access checkouts.
  /** What `operation` costs the owners, independent of what it returns. */
  const measure = async <T>(operation: () => Promise<T>) => {
    const graph = stack.fuseki.queries, access = stack.accessPool.checkouts;
    const result = await operation();
    return { result, graph: stack.fuseki.queries - graph, access: stack.accessPool.checkouts - access };
  };
  const app = createMainApp(stack.fuseki, { environment: stack.env, account, access: stack.access,
    targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool) });
  const call = (person: Person | null, method: string, path: string, body?: object, key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      ...(person ? { authorization: `Bearer ${person.token}` } : {}), 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const person = async (name: string) => {
    const made = await stack.member(name);
    people.set(made.token, made);
    return made;
  };
  const owner = await person('rating-owner');
  await owner.grant('space:create:root', 'space.create');
  const realm = (await json<{ realm: string }>(await call(owner, 'POST', '/v1/spaces', { profile: 'space-realm-v1',
    name: `Ratings ${randomUUID()}`, language: 'en', capabilities: ['realm'], actingSubject: owner.actor }), 201)).realm;
  await owner.grant('semantic:create:root', 'semantic.change');
  const resource = async (name: string) => {
    const created = await json<{ component: string }>(await call(owner, 'POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en', direction: 'ltr' } }] } }), 201);
    await owner.grant(`semantic:read:${created.component}`, 'semantic.read');
    return created.component;
  };
  await owner.grant(`rating:context:${realm}`, 'rating.context.create');
  const context = async (body: Record<string, unknown> = {}) => json<{ context: string; contextRevision: string;
    displayThreshold: number; profile: string }>(await call(owner, 'POST', '/v1/rating-contexts', { profile: 'realm-target-rating-context-v3', realm,
    question: `How good is this character? ${randomUUID().slice(0, 8)}`, language: 'en', targetGrain: 'resource',
    actingSubject: owner.actor, ...body }), 201);
  const granted = new Set<string>();
  /** Writes one standing rating through the API and returns its receipt. */
  const rate = async (rater: Person, contextId: string, target: string, value: number | null,
    expectedRevisionHead: string | null = null): Promise<Opinion> => {
    if (!granted.has(`${rater.token}:${contextId}`)) {
      await rater.grant(`rating:observe:${contextId}`, 'rating.observation.set');
      granted.add(`${rater.token}:${contextId}`);
    }
    if (!granted.has(`${rater.token}:${target}`)) {
      await rater.grant(`semantic:read:${target}`, 'semantic.read');
      granted.add(`${rater.token}:${target}`);
    }
    return json<Opinion>(await call(rater, 'POST', '/v1/rating-observations', { profile: 'realm-target-rating-observation-v1',
      context: contextId, target, value, expectedRevisionHead, actingSubject: rater.actor }), 201);
  };
  const aggregate = async (contextId: string, target: string, reader: Person = owner) => json<Aggregate>(
    await call(reader, 'POST', '/v1/rating-aggregates', { profile: 'realm-target-latest-mean-v1', context: contextId, target,
      actingSubject: reader.actor }));
  /** Components as Access holds them, and the same figures recomputed from its sealed heads. */
  const components = async (contextId: string, target: string) => {
    const row = (await stack.accessPool.query(`SELECT slots, unvalued, rating_count AS count, rating_sum::int AS sum, histogram
      FROM access.target_rating_component WHERE context = $1 AND target = $2`, [contextId, target])).rows[0] ?? null;
    const heads = (await stack.accessPool.query(`SELECT value, value_known, count(*)::int AS n FROM access.target_rating_head
      WHERE context = $1 AND target = $2 GROUP BY value, value_known`, [contextId, target])).rows as
      { value: number | null; value_known: boolean; n: number }[];
    const histogram = Array.from({ length: 10 }, (_, index) => heads.find(head => head.value === index + 1)?.n ?? 0);
    const recomputed = { slots: heads.reduce((total, head) => total + head.n, 0),
      unvalued: heads.filter(head => !head.value_known).reduce((total, head) => total + head.n, 0),
      count: histogram.reduce((total, n) => total + n, 0),
      sum: histogram.reduce((total, n, index) => total + n * (index + 1), 0), histogram };
    return { row, recomputed };
  };
  const expectComponentsMatchHeads = async (contextId: string, target: string) => {
    const { row, recomputed } = await components(contextId, target);
    expect(row).toEqual(recomputed);
  };
  /** Recompute across target rows for fixture assertions; no Context totals are stored. */
  const contextTotals = async (contextId: string) => (await stack.accessPool.query(`SELECT count(*)::int AS targets,
    sum(slots)::int AS slots, sum(unvalued)::int AS unvalued, sum(rating_count)::int AS count, sum(rating_sum)::int AS sum,
    ARRAY(SELECT sum(u.h)::int FROM access.target_rating_component s, unnest(s.histogram) WITH ORDINALITY AS u(h, i)
      WHERE s.context = $1 GROUP BY u.i ORDER BY u.i) AS histogram
    FROM access.target_rating_component WHERE context = $1 HAVING count(*) > 0`, [contextId])).rows[0] ?? null;
  return { stack, app, call, json, person, owner, realm, resource, context, rate, aggregate, components, measure,
    expectComponentsMatchHeads, contextTotals, stop: () => stack.stop() };
}
