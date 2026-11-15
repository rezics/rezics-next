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
import { isRelationProperty, relationSlotForApi } from '../../../src/semantic/item.ts';
import { latestAdoption } from '../../../src/semantic/slots.ts';
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
  const auth = await nativeFixture(pool, () => db.openPool({ max: 8 }));
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
  const candidateStatements = new Map<string, { subject: string; statement: unknown }>();
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const proposalSubject = /^\/v1\/subjects\/([^/]+)\/candidates$/.exec(path)?.[1];
    if (method === 'POST' && proposalSubject && record(body) && typeof response.body.candidate === 'string')
      candidateStatements.set(response.body.candidate, { subject: proposalSubject, statement: body.statement });
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
  async function adopt(id: string, property: string, candidates: string[], expectedHead?: number | null) {
    const active = await activeRelease(pool);
    if (!active) throw new Error('List adoption requires an active release');
    const relation = active.release.properties[property]?.relation;
    type Address = { target?: string; sameAs?: string; key?: string };
    const groups = new Map<string, { address: Address; candidates: string[] }>();
    for (const candidate of candidates) {
      const proposed = candidateStatements.get(candidate);
      if (!proposed || proposed.subject !== id || !record(proposed.statement))
        throw new Error('List adoption requires its actual proposed candidate');
      const statement = proposed.statement;
      if (!record(statement.property) || statement.property.id !== property || !record(statement.value))
        throw new Error('List adoption property does not match its proposal');
      const address: Address = {};
      if (isRelationProperty(active.release, property)) {
        const qualifiers = Array.isArray(statement.qualifiers) ? statement.qualifiers : [];
        const qualifierValue = (name: string) => {
          for (const qualifier of qualifiers) {
            if (!record(qualifier) || !record(qualifier.property) || qualifier.property.id !== name) continue;
            if (record(qualifier.value) && qualifier.value.type === 'value' && typeof qualifier.value.content === 'string')
              return qualifier.value.content;
          }
          return undefined;
        };
        if (statement.value.type === 'value' && typeof statement.value.content === 'string' && routeOf(statement.value.content) !== null) {
          address.target = statement.value.content;
          const key = relation?.slotKey && qualifierValue(relation.slotKey);
          if (typeof key === 'string') address.key = key;
        } else if (statement.value.type === 'somevalue') {
          const sameAs = qualifierValue('schema:sameAs');
          if (sameAs !== undefined) address.sameAs = sameAs;
        }
      }
      const slot = relationSlotForApi(id, property, relation, address);
      const group = groups.get(slot) ?? { address, candidates: [] };
      group.candidates.push(candidate);
      groups.set(slot, group);
    }
    if (!groups.size)
      groups.set(relationSlotForApi(id, property, relation, {}), { address: {}, candidates: [] });
    for (const [slot, group] of groups) {
      for (const candidate of group.candidates)
        await checked('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
          context: GLOBAL_CONTEXT,
          expected_head: null,
        });
      const current = expectedHead === undefined ? await latestAdoption(pool, id, property, GLOBAL_CONTEXT, slot) : null;
      await checked('POST', `/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        ...group.address,
        expected_head: expectedHead === undefined ? current?.head ?? null : expectedHead,
        mode: 'replace',
        selection: group.candidates.map((candidate) => ({ candidate, rank: 'normal' })),
      });
    }
    await drain();
  }
  async function hide(id: string) {
    await checked('POST', `/v1/subjects/${id}:hide`, { reason: 'List disclosure test' });
  }
  async function batch(command: Extract<BatchCommand, { op: 'create' }>): Promise<{ id: string; revision: number }>;
  async function batch(command: Extract<BatchCommand, { op: 'propose' }>): Promise<{ candidate: string; revision: number }>;
  async function batch(command: Extract<BatchCommand, { op: 'retract' }>): Promise<{ revision: number }>;
  async function batch(command: BatchCommand): Promise<{ id?: string; candidate?: string; revision: number }>;
  async function batch(command: BatchCommand): Promise<{ id?: string; candidate?: string; revision: number }> {
    const result = await checked('POST', '/v1/subjects:batchWrite', { commands: [command] });
    const rows: unknown = result.results;
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0]))
      throw new Error('List batch returned an invalid result count');
    const row = rows[0];
    expect(row.status, JSON.stringify(result)).toBeLessThan(300);
    if ((row.status !== 200 && row.status !== 201) || row.key !== command.key || !record(row.value))
      throw new Error('List batch did not return the requested successful outcome');
    const value = row.value;
    if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1)
      throw new Error('List batch returned an invalid revision');
    const revision = value.revision;
    if (command.op === 'create') {
      if (typeof value.id !== 'string' || routeOf(value.id) === null) throw new Error('List batch returned no native subject');
      return { id: value.id, revision };
    }
    if (command.op === 'propose') {
      if (typeof value.candidate !== 'string' || routeOf(value.candidate) !== routeOf(command.subject))
        throw new Error('List batch returned no native candidate on its subject route');
      candidateStatements.set(value.candidate, { subject: command.subject, statement: command.statement });
      return { candidate: value.candidate, revision };
    }
    return { revision };
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
    const id = result.id;
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
    await adopt(id, property, [proposed.candidate]);
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
