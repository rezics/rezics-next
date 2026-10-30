import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Source, BatchCommand } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../../src/http/kernel.ts';
import type { Access, Actor } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { createRealAccess } from '../real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

export const listRouteKey = new Uint8Array(32).fill(127);
export const citedValue = (property: string, content: unknown, references = true) => ({
  property: { id: property },
  value: { type: 'value', content },
  ...(references
    ? {
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/list-facts' } },
            ],
          },
        ],
      }
    : {}),
});

/** Thin native API setup: no selected values, mapping, readiness or receipt is preseeded. */
export async function createListPresentationFixture(options: { poolMax?: number; db?: GrowthDatabase } = {}) {
  const db = options.db ?? (await openGrowthDatabase());
  const pool: Pool = db.openPool({ max: options.poolMax ?? 1 });
  let held = 0,
    maximum = 0;
  pool.on('acquire', () => {
    held++;
    maximum = Math.max(maximum, held);
  });
  pool.on('release', () => {
    held--;
  });
  const accounts = { operator: newId(0x7c10), editor: newId(0x7c20), reader: newId(0x7c30) };
  const actions = [
    'access:grant',
    'gate:any',
    'subject:create',
    'subject:read',
    'subject:batch_write',
    'subject:merge',
    'statement:propose',
    'account:delete',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
    'source_fence:takedown',
    'definitions:publish',
    'definitions:activate',
  ];
  const real = await createRealAccess(db.admin, accounts, actions);
  const global = { route: 0, id: GLOBAL_CONTEXT };
  // Only the bootstrap administrator receives setup authority directly. Every publisher grant below uses the API.
  await real.grant(global, 'operator', 'access:grant');
  await real.grant(global, 'operator', 'gate:any');
  await db.admin.query(
    "UPDATE access.account SET rate_tier='trusted' WHERE route=ANY($1::integer[]) AND account_id=ANY($2::uuid[])",
    [Object.values(accounts).map((id) => routeOf(id)!), Object.values(accounts)],
  );
  await bootstrapRelease(pool, bundledRelease);
  let access!: Access;
  const kernel = createKernel({
    pool,
    routeKey: listRouteKey,
    writeRate: real.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(126)]]) },
    access(config) {
      access = real.access(config);
      return access;
    },
  });
  type Persona = keyof typeof accounts | 'anonymous';
  async function call(method: string, path: string, body?: unknown, as: Persona = 'editor') {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(as === 'anonymous' ? {} : { authorization: `Bearer ${real.bearer(as)}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }
  async function checked(method: string, path: string, body?: unknown, as: Persona = 'editor') {
    const response = await call(method, path, body, as);
    expect([200, 201, 202], `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`).toContain(
      response.status,
    );
    return response.body;
  }
  async function grant(persona: 'editor' | 'reader', action: string, resource = global) {
    await checked(
      'POST',
      '/v1/grants',
      { resource, subject: { kind: 'account', id: accounts[persona] }, actions: [action], valid: '(,)' },
      'operator',
    );
  }
  for (const action of actions.filter(
    (action) => !['access:grant', 'gate:any', 'subject:read', 'account:delete'].includes(action),
  ))
    await grant('editor', action);
  for (const gate of ['gate:subject_identity', 'gate:definition_publication']) await grant('editor', gate);
  const homes = new Set<number>();
  const projection = linkProjection(pool);
  async function drain() {
    for (let step = 0; step < 200; step++) {
      let pending = false;
      for (const home of homes) {
        const result = await projection.run(home);
        pending ||= result.status === 'busy' || result.envelopes > 0;
      }
      if (!pending) return;
    }
    throw new Error('List fixture native link projection did not drain');
  }
  async function create(type: string, values: Record<string, unknown> = {}, labels = { en: 'Native list subject' }) {
    const result = await checked('POST', '/v1/subjects', {
      type,
      labels,
      statements: Object.fromEntries(
        Object.entries(values).map(([property, content]) => [
          property,
          (Array.isArray(content) ? content : [content]).map((value) => citedValue(property, value)),
        ]),
      ),
    });
    const id = result.subject.id as string;
    homes.add(partitionOf(routeOf(id)!));
    await drain();
    return id;
  }
  async function propose(id: string, property: string, content: unknown, referenced = true, as: Persona = 'editor') {
    const result = await checked(
      'POST',
      `/v1/subjects/${id}/candidates`,
      { statement: citedValue(property, content, referenced) },
      as,
    );
    homes.add(partitionOf(routeOf(id)!));
    await drain();
    return result.candidate as string;
  }
  async function adopt(id: string, property: string, candidates: string[], expectedHead: number | null = null) {
    for (const candidate of candidates)
      await checked('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      });
    await checked('POST', `/v1/subjects/${id}:adopt`, {
      context: GLOBAL_CONTEXT,
      property,
      expected_head: expectedHead,
      mode: 'replace',
      selection: candidates.map((candidate) => ({ candidate, rank: 'normal' })),
    });
    await drain();
  }
  async function hide(id: string) {
    await checked('POST', `/v1/subjects/${id}:hide`, { reason: 'List disclosure test' });
  }
  async function batch(command: BatchCommand) {
    const result = await checked('POST', '/v1/subjects:batchWrite', { commands: [command] });
    expect(result.results[0].status, JSON.stringify(result)).toBeLessThan(300);
    return result.results[0].value as Record<string, any>;
  }
  async function imported(property: string, content: unknown) {
    const source: Source = {
      source: 'native_list_fixture',
      external_id: randomUUID(),
      record_revision: '1',
      digest: 'a'.repeat(64),
      converter_revision: '1',
      field_group: 'facts',
    };
    const result = await batch({
      op: 'create',
      key: randomUUID(),
      source,
      subject: {
        type: 'schema:Book',
        labels: { en: 'Native imported book' },
        statements: { [property]: [citedValue(property, content)] },
      },
    });
    const id = result.subject.id as string;
    homes.add(partitionOf(routeOf(id)!));
    await drain();
    return { id, source };
  }
  async function publish(release: Release) {
    const active = await activeRelease(pool);
    const published = await checked('POST', '/v1/definitions/releases', { release });
    await checked('POST', `/v1/definitions/releases/${published.digest}:activate`, {
      expected_head: active?.head ?? null,
    });
    return published.digest as string;
  }
  async function deps(as: Persona = 'anonymous') {
    kernel.compile();
    const deadline = Date.now() + 30_000;
    const actor: Actor =
      as === 'anonymous' ? { kind: 'anonymous' } : await access.authenticate(real.bearer(as), { pool, deadline });
    return { pool, access, actor, routeKey: listRouteKey, deadline };
  }
  return {
    db,
    pool,
    accounts,
    real,
    kernel,
    call,
    checked,
    grant,
    create,
    propose,
    adopt,
    hide,
    imported,
    batch,
    drain,
    publish,
    deps,
    maximumHeldBackends: () => maximum,
    close: async () => {
      if (!options.db) await db.close();
    },
  };
}
export type ListPresentationFixture = Awaited<ReturnType<typeof createListPresentationFixture>>;
