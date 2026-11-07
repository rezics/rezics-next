import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Source, BatchCommand } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Actor } from '../../../src/request/access.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { nativeFixture } from '../../access/native-account-bindings-fixture.ts';
import { createPersonas } from '../../support/personas.ts';
import { testKernel, testRouteKey } from '../../support/test-kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { installSemanticCopyWork } from '../../../src/composition/semantic-copy-work.ts';
import { deletePersona } from '../../support/account-deletion.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { identityEpochDatabase } from './identity-epoch.ts';

export const listRouteKey = testRouteKey();
export const citedValue = (property: string, content: unknown, references = true) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
  ...(references
    ? {
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value' as const, content: 'https://example.test/list-facts' },
              },
            ],
          },
        ],
      }
    : {}),
});

/** Thin native API setup: no selected values, mapping, readiness or receipt is preseeded. */
export async function createListPresentationFixture(options: { poolMax?: number; db?: GrowthDatabase } = {}) {
  installSemanticCopyWork();
  const isolated = options.db ? undefined : await identityEpochDatabase();
  const db = options.db ?? (await openGrowthDatabase(isolated!.url));
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
  await bootstrapRelease(pool, bundledRelease);
  const auth = await nativeFixture(pool, () => db.openPool({ max: 1 }));
  const service = auth.host.service;
  const kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'list-presentation-native-api-write-rate-secret',
      overrides: JSON.stringify(
        Object.fromEntries(
          ['new-account', 'member', 'trusted', 'service'].map((kind) => [
            kind,
            { write: { maximum: 100000, seconds: 60 } },
          ]),
        ),
      ),
    }),
  });
  const people = await createPersonas(kernel, { version: 1, pool, auth });
  const personas = {
    operator: people.staff,
    editor: people.alice,
    reader: people.bob,
    suspended: people.suspended,
    revoked: people.revoked,
  };
  const accounts = Object.fromEntries(
    Object.entries(personas).map(([name, person]) => [name, person.accountId]),
  ) as Record<keyof typeof personas, string>;
  const access = kernel.testAccess;
  const global = { route: 0, id: GLOBAL_CONTEXT };
  const actions = [
    'subject:create',
    'subject:batch_write',
    'subject:merge',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
    'source_fence:takedown',
    'definitions:publish',
    'definitions:activate',
  ];
  type Persona = keyof typeof personas | 'anonymous';
  async function call(
    method: string,
    path: string,
    body?: unknown,
    as: Persona = 'editor',
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(as === 'anonymous' ? {} : { authorization: `Bearer ${personas[as].bearer}` }),
          ...extraHeaders,
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
  for (const action of actions) await grant('editor', action);
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
  async function create(
    type: string,
    values: Record<string, unknown> = {},
    labels: Record<string, string> = { en: 'Native list subject' },
    statements: Record<string, unknown[]> = {},
  ) {
    const result = await checked('POST', '/v1/subjects', {
      type,
      labels,
      statements: {
        ...Object.fromEntries(
          Object.entries(values).map(([property, content]) => [
            property,
            (Array.isArray(content) ? content : [content]).map((value) => citedValue(property, value)),
          ]),
        ),
        ...statements,
      },
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
      },
    });
    const id = result.id as string;
    const proposed = await batch({
      op: 'propose',
      key: randomUUID(),
      source,
      subject: id,
      statement: {
        ...citedValue(property, content),
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value' as const, content: 'https://example.test/list-facts' },
              },
            ],
          },
        ],
      },
    });
    await adopt(id, property, [proposed.candidate as string]);
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
  if ((await activeRelease(pool))?.digest !== bundledDigest) await publish(bundledRelease);
  async function deps(as: Persona = 'anonymous') {
    kernel.compile();
    const deadline = Date.now() + 30_000;
    const actor: Actor =
      as === 'anonymous' ? { kind: 'anonymous' } : await access.authenticate(personas[as].bearer, { pool, deadline });
    return { pool, access, actor, routeKey: listRouteKey, deadline };
  }
  return {
    db,
    pool,
    accounts,
    auth,
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
    erase: () => deletePersona({ version: 1, pool, auth }, personas.editor),
    maximumHeldBackends: () => maximum,
    close: async () => {
      try {
        await auth.close();
      } finally {
        if (!options.db) {
          try {
            await db.close();
          } finally {
            await isolated!.close();
          }
        }
      }
    },
  };
}
export type ListPresentationFixture = Awaited<ReturnType<typeof createListPresentationFixture>>;
