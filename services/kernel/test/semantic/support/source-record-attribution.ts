import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { BatchCommand, BatchStatement, Source } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../../src/http/kernel.ts';
import { tupleRoute } from '../../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { createRealAccess } from '../real-access.ts';
import { seed, type GrowthDatabase } from '../../support/growth.ts';
import { itemFacts } from '../../../src/semantic/item.ts';
import { labelOrderKey } from '../../../src/semantic/link-keys.ts';

// Structural future HTTP boundary: no successful fallback or missing-module TS error.
export type SourceRecord = {
  name: string;
  url: string;
  licence?: { id: string; url?: string };
  attribution?: string;
};
export type MetadataCommand = {
  source: string;
  external_id: string;
  metadata: SourceRecord;
  expected_metadata_revision: number | null;
};
export const metadataPath = '/v1/source-records:setMetadata';
export const metadataKind = 'source_record.set_metadata';
export const routeKey = new Uint8Array(32).fill(113);
export const global = { route: 0, id: GLOBAL_CONTEXT };
export const source = (external_id: string = randomUUID(), alias = 'registered_catalogue'): Source => ({
  source: alias,
  external_id,
  record_revision: 'upstream-original',
  digest: 'a'.repeat(64),
  converter_revision: 'converter-original',
  field_group: 'facts',
});

// Explicit reviewed registration snapshot, not an alias/URL heuristic or importer implementation.
export const registeredBangumi = (externalId: string): SourceRecord => ({
  name: 'Bangumi',
  url: `https://bgm.tv/subject/${encodeURIComponent(externalId)}`,
  licence: { id: 'CC-BY-SA-3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  attribution: 'Bangumi contributors',
});
export const cited = (property = 'schema:inLanguage', content: unknown = 'ja'): BatchStatement => ({
  property: { id: property },
  value: { type: 'value', content },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } }] },
  ],
});
export type Answer = { status: number; body: Record<string, any> };
export function status(answer: Answer, expected: number) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(expected);
  return answer.body;
}
export function records(subject: Record<string, any>): SourceRecord[] {
  expect(subject.sourceRecords, 'native Subject DTO must contain sourceRecords').toBeArray();
  for (const record of subject.sourceRecords) {
    expect(Object.keys(record).sort()).toEqual(
      ['name', 'url', ...(record.licence ? ['licence'] : []), ...(record.attribution ? ['attribution'] : [])].sort(),
    );
  }
  return subject.sourceRecords;
}

export async function attributionFixture(db: GrowthDatabase, pool: Pool = db.pool) {
  const accounts = { importer: newId(29000), editor: newId(29016), ordinary: newId(29032), person: newId(29048) };
  const actions = [
    'subject:create',
    'subject:read',
    'subject:batch_write',
    'subject:merge',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'source_fence:takedown',
  ];
  const real = await createRealAccess(db.admin, accounts, actions);
  for (const action of actions) await real.grant(global, 'importer', action);
  for (const action of ['subject:create', 'statement:propose', 'context:accept', 'context:adopt']) {
    await real.grant(global, 'editor', action);
    await real.grant(global, 'person', action);
  }
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  const kernel = createKernel({
    pool,
    access(config) {
      const catalogue = new Map(config.actions);
      if (!catalogue.has('source_fence:takedown')) catalogue.set('source_fence:takedown', { anonymous: false });
      return real.access({ ...config, actions: catalogue });
    },
    writeRate: real.writeRate,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(114)]]) },
  });
  type Persona = keyof typeof accounts;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    as: Persona | null = 'importer',
    key = randomUUID(),
  ) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(as ? { authorization: `Bearer ${real.bearer(as)}` } : {}),
          ...(method === 'POST' ? { 'idempotency-key': `"${key}"` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    let value: Record<string, any>;
    try {
      value = JSON.parse(text);
    } catch {
      value = { raw: text };
    }
    return { status: response.status, body: value };
  }
  async function batch(command: BatchCommand) {
    const body = status(await call('POST', '/v1/subjects:batchWrite', { commands: [command] }), 200);
    expect(body.results).toHaveLength(1);
    return body.results[0] as { status: number; value: Record<string, any>; problem?: unknown };
  }
  async function create(origin = source()) {
    const command: BatchCommand = {
      op: 'create',
      key: randomUUID(),
      source: origin,
      subject: { type: 'schema:Book', labels: { en: 'Native attribution book' } },
    };
    const result = await batch(command);
    expect(result.status, JSON.stringify(result)).toBe(201);
    return { id: result.value.id as string, command, result, origin };
  }
  async function propose(
    id: string,
    origin: Source,
    statement = cited(),
    rights?: Extract<BatchCommand, { op: 'propose' }>['rights'],
  ) {
    const result = await batch({
      op: 'propose',
      key: randomUUID(),
      subject: id,
      source: origin,
      statement,
      ...(rights ? { rights } : {}),
    });
    expect(result.status, JSON.stringify(result)).toBe(201);
    return result.value.candidate as string;
  }
  async function adopt(
    id: string,
    candidates: string[],
    property = 'schema:inLanguage',
    mode = 'replace',
    target?: string,
  ) {
    const listing = status(
      await call(
        'GET',
        `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}${target ? `&target=${target}` : ''}`,
      ),
      200,
    );
    return status(
      await call('POST', `/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        mode,
        selection: candidates.map((candidate, i) => ({ candidate, rank: i === 0 ? 'preferred' : 'normal' })),
        expected_head: listing.adoption?.head ?? null,
        ...(target ? { target } : {}),
      }),
      200,
    );
  }
  async function select(id: string, candidate: string, property = 'schema:inLanguage', target?: string) {
    status(
      await call('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      }),
      200,
    );
    await adopt(id, [candidate], property, 'replace', target);
  }
  async function metadata(
    origin: Source,
    metadata: SourceRecord,
    expected_metadata_revision: number | null = null,
    key = randomUUID(),
  ) {
    return call(
      'POST',
      metadataPath,
      {
        source: origin.source,
        external_id: origin.external_id,
        metadata,
        expected_metadata_revision,
      } satisfies MetadataCommand,
      'importer',
      key,
    );
  }
  async function filled(origin: Source, record = registeredBangumi(origin.external_id)) {
    const body = status(await metadata(origin, record), 201);
    expect(body).toEqual({ record, metadata_revision: 1, effect: 'filled' });
    return record;
  }
  async function read(id: string, as: Persona | null = null) {
    return status(await call('GET', `/v1/subjects/${id}`, undefined, as), 200).subject as Record<string, any>;
  }
  const projection = linkProjection(pool);
  async function drain(...ids: string[]) {
    for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!)))) {
      let done = false;
      for (let step = 0; step < 200; step++) {
        const result = await projection.run(partition);
        if (result.status === 'read' && result.envelopes === 0) {
          done = true;
          break;
        }
      }
      if (!done) throw new Error('Native attribution projection did not drain');
    }
  }
  async function receipt(key: string, kind = metadataKind, origin?: Source) {
    const result = await db.admin.query(
      `SELECT partition_no, principal_kind, principal_id, command_kind, idempotency_key,
       encode(request_digest,'hex') AS digest, epoch, position::text, transaction_id, response
       FROM core.receipt WHERE principal_id=$1 AND command_kind=$2 AND idempotency_key=$3`,
      [accounts.importer, kind, key],
    );
    if (origin && result.rows.length)
      expect(result.rows[0].partition_no).toBe(partitionOf(tupleRoute(routeKey, origin.source, origin.external_id)));
    return result.rows;
  }
  async function nativeSnapshot(id: string) {
    const route = routeOf(id)!;
    const [subject, revisions, claims] = await Promise.all([
      db.admin.query('SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2', [route, id]),
      db.admin.query('SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision', [route, id]),
      db.admin.query('SELECT * FROM semantic.external_claim WHERE subject_id=$1 ORDER BY route,source,external_id', [
        id,
      ]),
    ]);
    return { subject: subject.rows, revisions: revisions.rows, claims: claims.rows };
  }
  async function historical(origin: Source, consent?: { target: string; account: string }) {
    // Load immutable historical source provenance at INSERT, never rewrite an old revision.
    const id = newId(29100);
    const route = routeOf(id)!;
    const transaction = randomUUID();
    const property = consent ? 'rezics:penNameOf' : 'schema:inLanguage';
    const statement = consent ? { ...cited(property, consent.target), references: [] } : cited();
    const type = consent ? 'schema:Person' : 'schema:Book';
    const labels = { en: 'Historical sourced support' };
    const facts = itemFacts(id, { type, labels, statements: { [property]: [statement] } }, type, bundledRelease);
    const fact = facts.find((row) => row.kind === 'statement')!;
    const candidate = fact.statement_id!;
    await seed(
      { pool, admin: db.admin },
      {
        name: `historical-source-${id}`,
        hotPartition: partitionOf(route),
        hotShare: 1,
        rows: () => ({
          'semantic.subject': [
            {
              route,
              subject_id: id,
              type,
              recorded_transaction_id: transaction,
              current_facts: facts.length,
              current_release: bundledDigest,
            },
          ],
          'semantic.revision': [
            {
              route,
              subject_id: id,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
              source: origin,
            },
          ],
          'semantic.fact': facts.map((row) => ({
            ...row,
            route,
            subject_id: id,
            ...(consent && row.kind === 'statement' ? { operation: 'expand', statement_id: null, body: {} } : {}),
            recorded_transaction_id: transaction,
            release: row.kind === 'statement' && !consent ? bundledDigest : null,
            relation: Boolean(consent && row.kind === 'statement'),
          })),
          ...(consent
            ? {
                'semantic.candidate': [
                  {
                    route,
                    subject_id: id,
                    candidate_id: candidate,
                    slot_id: fact.slot_id,
                    property,
                    rank: 'normal',
                    statement: fact.body,
                    release: bundledDigest,
                    revision: 1,
                    origin: 'compact',
                    view_order: 0,
                    relation: true,
                  },
                ],
                'semantic.statement_disclosure': [
                  {
                    route,
                    subject_id: id,
                    candidate_id: candidate,
                    target_id: consent.target,
                    account_id: consent.account,
                    property,
                    disclosed: false,
                    source_order_key: labelOrderKey(labels),
                    target_order_key: labelOrderKey({ en: 'Consent owner' }),
                  },
                ],
              }
            : {}),
        }),
      },
      { from: 0, to: 1 },
    );
    if (consent) await select(id, candidate, property, consent.target);
    return { id, candidate };
  }
  async function stored(origin: Source) {
    return (
      await db.admin.query('SELECT * FROM semantic.source_record WHERE route=$1 AND source=$2 AND external_id=$3', [
        tupleRoute(routeKey, origin.source, origin.external_id),
        origin.source,
        origin.external_id,
      ])
    ).rows;
  }
  return {
    db,
    pool,
    accounts,
    real,
    call,
    batch,
    create,
    propose,
    adopt,
    select,
    metadata,
    filled,
    read,
    drain,
    receipt,
    nativeSnapshot,
    stored,
    historical,
  };
}
export type AttributionFixture = Awaited<ReturnType<typeof attributionFixture>>;
