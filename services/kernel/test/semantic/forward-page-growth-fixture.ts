import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts, type Fact } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createRealAccess } from './real-access.ts';
import { type GrowthDatabase, type Population } from '../support/growth.ts';
import { seedSemanticPopulation, unrelatedSemanticPopulation } from './planner-fixtures.ts';

export const PROPERTY = 'schema:author';
export const PAGE_SIZE = 25;
export const LOOKAHEAD = 1;
export const TRAILER = PAGE_SIZE + LOOKAHEAD;
export const SCALES = [64, 512, 4096] as const;
export const NIL = '00000000-0000-0000-0000-000000000000';
const RING = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const ROUTE_KEY = new Uint8Array(32).fill(42);

export const statement = (target: string) => ({
  property: { id: PROPERTY },
  value: { type: 'value', content: target },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } }] },
  ],
});

export function disclosedLabel(ordinal: number): string {
  return `Author ${String(ordinal).padStart(4, '0')}`;
}

export type ForwardPage = {
  relations: { target: string | null; label?: string; statement?: { id: string } }[];
  next: string | null;
  freshness?: { consistency: string; caught_up: boolean };
  session?: string;
};

export type PublicCursors = {
  rejected: string;
  deep: string;
  empty: string;
};

export async function forwardPageGrowthFixture(db: GrowthDatabase) {
  const editor = newId(28_000);
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
      const declared = new Map(config.actions);
      if (!declared.has('source_fence:takedown')) declared.set('source_fence:takedown', { anonymous: false });
      return access.access({ ...config, actions: declared });
    },
    writeRate: access.writeRate,
    tokens: RING,
    routeKey: ROUTE_KEY,
    requestDeadlineMs: 30_000,
  });
  const projection = linkProjection(db.pool);
  const partitions = new Set<number>();
  let session: string | undefined;

  async function call(method: string, path: string, body?: unknown): Promise<{ value: Record<string, any>; session?: string }> {
    const headers: Record<string, string> = { authorization: `Bearer ${access.bearer('editor')}` };
    if (session) headers[SESSION_HEADER] = session;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers[IDEMPOTENCY_HEADER] = `"${randomUUID()}"`;
    }
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const nextSession = response.headers.get(SESSION_HEADER) ?? session;
    if (nextSession) session = nextSession;
    const value = (await response.json()) as Record<string, any>;
    expect([200, 201], `${method} ${path}: ${response.status} ${JSON.stringify(value)}`).toContain(response.status);
    return nextSession ? { value, session: nextSession } : { value };
  }

  async function create(label: string, type: string, statements: Record<string, ReturnType<typeof statement>[]> = {}) {
    const { value } = await call('POST', '/v1/subjects', {
      type,
      labels: { en: label },
      ...(Object.keys(statements).length ? { statements } : {}),
    });
    const id = value.subject.id as string;
    partitions.add(partitionOf(routeOf(id)!));
    return value.subject as { id: string; labels: Record<string, string> };
  }

  async function drain() {
    for (let step = 0; step < 200; step++) {
      let pending = false;
      for (const partition of partitions) {
        const result = await projection.run(partition);
        pending ||= result.status === 'busy' || result.envelopes > 0;
      }
      if (!pending) return;
    }
    throw new Error('Forward-page fixture projection did not drain');
  }

  const hidden = await create('Author 0025a', 'schema:Person');
  const denied = await create('Author 0025b', 'schema:Person');
  const holder = await create('Forward page growth holder', 'schema:Book', {
    [PROPERTY]: [statement(hidden.id), statement(denied.id)],
  });
  await drain();
  await call('POST', `/v1/subjects/${hidden.id}:hide`, { reason: 'Target withheld.' });
  const denialTransaction = randomUUID();
  await db.admin.query(
    `INSERT INTO access.resource_denial
       (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(denied.id), denied.id, editor, denialTransaction],
  );

  const holderRoute = routeOf(holder.id)!;
  const holderPartition = partitionOf(holderRoute);
  const people = Array.from({ length: 4096 }, () => newId(holderRoute));
  const trailer = Array.from({ length: TRAILER }, () => newId(holderRoute));
  const peopleFacts: Fact[][] = people.map((id, ordinal) =>
    itemFacts(id, { labels: { en: disclosedLabel(ordinal) } }, 'schema:Person', bundledRelease),
  );
  const relationFacts: Fact[] = people.map((id) =>
    itemFacts(
      holder.id,
      { labels: { en: 'Forward page growth holder' }, statements: { [PROPERTY]: [statement(id)] } },
      'schema:Book',
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );

  function targetRows(
    id: string,
    facts: Fact[],
    transaction: string,
    visibility: 'visible' | 'hidden',
  ): Record<string, Record<string, unknown>[]> {
    return {
      'semantic.subject': [
        {
          route: holderRoute,
          subject_id: id,
          type: 'schema:Person',
          recorded_transaction_id: transaction,
          visibility,
          security_revision: visibility === 'hidden' ? 1 : 0,
          current_facts: facts.length,
          current_release: bundledDigest,
          projection_pending: false,
        },
      ],
      'semantic.revision': [
        {
          route: holderRoute,
          subject_id: id,
          revision: 1,
          kind: 'create',
          release: bundledDigest,
          recorded_transaction_id: transaction,
        },
      ],
      'semantic.fact': facts.map((fact) => ({
        ...fact,
        route: holderRoute,
        subject_id: id,
        recorded_transaction_id: transaction,
        release: null,
        relation: false,
      })),
    };
  }

  function outboundRow(target: string, relation: Fact, orderKey: string, transaction: string) {
    return {
      route: holderRoute,
      subject_id: holder.id,
      context_id: GLOBAL_CONTEXT,
      property: PROPERTY,
      filter_value: NIL,
      order_key: orderKey,
      target_subject_id: target,
      statement_id: relation.statement_id,
      slot_id: relation.slot_id,
      relation: true,
      source_type: 'schema:Book',
      source_order_key: '',
      outbound_order: 'name',
      source_revision: 2,
      source_security_revision: 0,
      target_revision: 1,
      target_type: 'schema:Person',
      external: null,
      value: 'value',
      present: true,
      recorded_transaction_id: transaction,
    };
  }

  async function setMatchingCount(total: number) {
    await db.admin.query(
      `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
      [holderRoute, holder.id, PROPERTY, NIL, total],
    );
  }

  const trailerFacts = trailer.map((id, ordinal) =>
    itemFacts(id, { labels: { en: `Author z${String(ordinal).padStart(4, '0')}` } }, 'schema:Person', bundledRelease),
  );
  const trailerRelations = trailer.map((id) =>
    itemFacts(
      holder.id,
      { labels: { en: 'Forward page growth holder' }, statements: { [PROPERTY]: [statement(id)] } },
      'schema:Book',
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );
  const trailerPopulation: Population = {
    name: 'semantic-forward-page-trailer',
    hotPartition: holderPartition,
    hotShare: 1,
    rows({ ordinal }) {
      const id = trailer[ordinal]!;
      const transaction = randomUUID();
      const relationTransaction = randomUUID();
      const facts = trailerFacts[ordinal]!;
      const relation = trailerRelations[ordinal]!;
      const targets = targetRows(id, facts, transaction, 'hidden');
      return {
        ...targets,
        'semantic.revision': [
          ...targets['semantic.revision']!,
          {
            route: holderRoute,
            subject_id: holder.id,
            revision: 3 + ordinal,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: relationTransaction,
          },
        ],
        'semantic.fact': [
          ...targets['semantic.fact']!,
          {
            ...relation,
            route: holderRoute,
            subject_id: holder.id,
            recorded_transaction_id: relationTransaction,
            release: bundledDigest,
            relation: true,
          },
        ],
        'semantic.outbound_link': [
          outboundRow(id, relation, labelOrderKey({ en: `Author z${String(ordinal).padStart(4, '0')}` }), relationTransaction),
        ],
      };
    },
    async finish(admin, range) {
      await admin.query(
        `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES($1,$2)
         ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
        [holderPartition, range.to - range.from],
      );
    },
  };

  const degreePopulation: Population = {
    name: 'semantic-forward-page-degree',
    hotPartition: holderPartition,
    hotShare: 1,
    rows({ ordinal }) {
      const id = people[ordinal]!;
      const transaction = randomUUID();
      const relationTransaction = randomUUID();
      const facts = peopleFacts[ordinal]!;
      const relation = relationFacts[ordinal]!;
      const targets = targetRows(id, facts, transaction, 'visible');
      return {
        ...targets,
        'semantic.revision': [
          ...targets['semantic.revision']!,
          {
            route: holderRoute,
            subject_id: holder.id,
            revision: 100 + ordinal,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: relationTransaction,
          },
        ],
        'semantic.fact': [
          ...targets['semantic.fact']!,
          {
            ...relation,
            route: holderRoute,
            subject_id: holder.id,
            recorded_transaction_id: relationTransaction,
            release: bundledDigest,
            relation: true,
          },
        ],
        'semantic.outbound_link': [
          outboundRow(id, relation, labelOrderKey({ en: disclosedLabel(ordinal) }), relationTransaction),
        ],
      };
    },
    async finish(admin, range) {
      await admin.query(
        `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES($1,$2)
         ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
        [holderPartition, range.to - range.from],
      );
      await setMatchingCount(range.to + 2 + TRAILER);
    },
  };

  const historyPopulation = unrelatedSemanticPopulation(
    'semantic-forward-page-history',
    holderPartition,
  ).population;

  await seedSemanticPopulation(db, trailerPopulation, { from: 0, to: TRAILER });
  await setMatchingCount(2 + TRAILER);
  let matchingDegree = 0;

  async function forward(query: { cursor?: string; limit?: number } = {}): Promise<ForwardPage> {
    const limit = query.limit ?? PAGE_SIZE;
    const params = new URLSearchParams({ property: PROPERTY, limit: String(limit) });
    if (query.cursor) params.set('cursor', query.cursor);
    const { value, session: nextSession } = await call(
      'GET',
      `/v1/subjects/${holder.id}/relations?${params.toString()}`,
    );
    const page = value as ForwardPage;
    return nextSession ? { ...page, session: nextSession } : page;
  }

  async function issuePublicCursors(): Promise<PublicCursors> {
    const degree = matchingDegree;
    if (degree < PAGE_SIZE) throw new Error('Public cursors require a full first page of matching degree');
    const first = await forward();
    if (first.relations.length !== PAGE_SIZE)
      throw new Error(`First page did not deliver ${PAGE_SIZE} at degree ${degree}`);
    if (!first.next) throw new Error(`First page omitted its public continuation at degree ${degree}`);
    const rejected = first.next;
    const deepAt = Math.max(PAGE_SIZE + 1, Math.floor(degree / 2));
    let cursor: string | undefined = first.next;
    let seen = first.relations.length;
    let deep: string | undefined;
    let empty: string | undefined;
    for (let step = 0; step < 512 && cursor; step++) {
      const used = cursor;
      const page = await forward({ cursor: used });
      if (page.relations.length === 0 && page.next === null) {
        empty = used;
        break;
      }
      seen += page.relations.length;
      if (deep === undefined && used !== rejected && seen >= deepAt) deep = used;
      cursor = page.next ?? undefined;
    }
    if (!deep) throw new Error(`No public deep cursor at degree ${degree}`);
    if (!empty) throw new Error(`No public exhausted-empty cursor at degree ${degree}`);
    return { rejected, deep, empty };
  }

  async function growDegree(_database: GrowthDatabase, scale: number, previous: number) {
    await seedSemanticPopulation(db, degreePopulation, { from: previous, to: scale });
    matchingDegree = scale;
    const degree = await db.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM semantic.outbound_link
       WHERE route=$1 AND subject_id=$2 AND property=$3 AND filter_value=$4 AND present`,
      [holderRoute, holder.id, PROPERTY, NIL],
    );
    expect(Number(degree.rows[0]!.n)).toBe(scale + 2 + TRAILER);
  }

  async function growHistory(_database: GrowthDatabase, scale: number, previous: number) {
    await seedSemanticPopulation(db, historyPopulation, { from: previous, to: scale });
  }

  return {
    db,
    access,
    holder,
    hidden,
    denied,
    people,
    forward,
    issuePublicCursors,
    growDegree,
    growHistory,
  };
}

export type ForwardPageGrowthFixture = Awaited<ReturnType<typeof forwardPageGrowthFixture>>;
