import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { createRealAccess } from '../real-access.ts';
import type { GrowthDatabase } from '../../support/growth.ts';

export const property = 'schema:author';
export const nil = '00000000-0000-0000-0000-000000000000';
export const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(95)]]) };
export const statement = (id: string) => ({
  property: { id: property },
  value: { type: 'value', content: id },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } }] },
  ],
});

export async function aggregateFixture(db: GrowthDatabase) {
  const editor = newId(27000);
  const actions = [
    'subject:create',
    'subject:read',
    'subject:batch_write',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
    'source_fence:takedown',
  ];
  const access = await createRealAccess(db.admin, { editor }, actions);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  const kernel = createKernel({
    pool: db.pool,
    access(config) {
      const actions = new Map(config.actions);
      // The first mounted route catalogue must admit the protected Content command too.
      if (!actions.has('source_fence:takedown')) actions.set('source_fence:takedown', { anonymous: false });
      return access.access({ ...config, actions });
    },
    writeRate: access.writeRate,
    tokens: ring,
    routeKey: new Uint8Array(32).fill(96),
  });
  const projection = linkProjection(db.pool);
  const partitions = new Set<number>();
  async function call(method: string, path: string, body?: unknown) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${access.bearer('editor')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const value = (await response.json()) as Record<string, any>;
    expect([200, 201], `${method} ${path}: ${response.status} ${JSON.stringify(value)}`).toContain(response.status);
    return value;
  }
  async function create(
    label: string,
    targets: string[] = [],
    type = targets.length ? 'schema:Book' : 'schema:Person',
  ) {
    const { subject } = await call('POST', '/v1/subjects', {
      type,
      labels: { en: label },
      ...(targets.length ? { statements: { [property]: targets.map(statement) } } : {}),
    });
    partitions.add(partitionOf(routeOf(subject.id)!));
    return subject as { id: string; labels: Record<string, string>; statements: Record<string, { id: string }[]> };
  }
  // No relay is started. Only this explicit pre-mutation drain advances consumers.
  async function drain() {
    for (let step = 0; step < 200; step++) {
      let pending = false;
      for (const partition of partitions) {
        const result = await projection.run(partition);
        pending ||= result.status === 'busy' || result.envelopes > 0;
      }
      if (!pending) return;
    }
    throw new Error('Aggregate fixture projection did not drain');
  }
  async function stored(target: string) {
    const result = await db.admin.query(
      `SELECT value::int AS value FROM semantic.inbound_link_count
      WHERE context_id=$1 AND route=$2 AND subject_id=$3 AND property=$4 AND filter_value=$5`,
      [GLOBAL_CONTEXT, routeOf(target), target, property, nil],
    );
    return result.rows[0]?.value as number | undefined;
  }
  const inverse = (target: string, query = '') =>
    call('GET', `/v1/subjects/${target}/links?property=${property}${query}`);
  const graph = (target: string, direction = 'in') =>
    call('GET', `/v1/subjects/${target}/graph?property=${property}&direction=${direction}&depth=1&limit=1`);
  async function hide(source: string, verb = 'hide') {
    return call(
      'POST',
      `/v1/subjects/${source}:${verb}`,
      verb === 'takedown'
        ? { notice: { complaint: 'Whole source is withheld.', received_at: '2026-10-28T00:00:00Z' } }
        : { reason: 'Source withheld.' },
    );
  }
  return { db, access, partitions, call, create, drain, stored, inverse, graph, hide };
}
export type AggregateFixture = Awaited<ReturnType<typeof aggregateFixture>>;
