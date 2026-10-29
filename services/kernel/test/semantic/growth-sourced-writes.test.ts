import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest, type Release } from '@rezics/definitions';
import {
  BATCH_LIMIT,
  type BatchCommand,
  type BatchStatement,
  type Rights,
  type Source,
} from '@rezics/definitions/bulk';
import { fromPlainText } from '@rezics/document';
import type { PoolClient } from 'pg';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { itemFacts, relationSlotForApi } from '../../src/semantic/item.ts';
import { slotId } from '../../src/semantic/slots.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type Row,
} from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [1, 4, 16] as const;
const rowsPerScale = 500;
const warmupsAndRepetitions = 6;
const batchPartition = 0x123;
const routeKey = new Uint8Array(32).fill(73);
const rights: Rights = {
  license: 'CC-BY-SA-3.0',
  obligations: ['cc:Attribution', 'cc:ShareAlike'],
  attribution: 'Growth fixture contributors',
};
const accountRoute = 0x6543;
const accountId = newId(accountRoute);
const actions = [
  'subject:batch_write',
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'source_fence:takedown',
];
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const labelItem = { type: 'schema:Book', labels: { en: 'Growth fixture' } };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
const hexDigest = (value: string) => createHash('sha256').update(value).digest('hex');

let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let access: Awaited<ReturnType<typeof createRealAccess<{ importer: string }>>>;
const growthWriteRate = createWriteRateLimiter({
  secret: 'semantic-real-access-test-secret',
  overrides: JSON.stringify(
    Object.fromEntries(
      ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((principal) => [
        principal,
        { write: { maximum: 1_000_000, seconds: 60 } },
      ]),
    ),
  ),
});

type WriteFixture = { externalId: string; route: number; subject: string; media: string };
const subjectsPerBatch = 16;
const fixturesPerBatch = subjectsPerBatch + 2;
const tupleHomes = [batchPartition, batchPartition + 1, batchPartition + 2, batchPartition + 3];
const writeFixtures = new Map<number, readonly WriteFixture[]>();
const replayFixtures = new Map<
  number,
  {
    commands: BatchCommand[];
    results: Record<string, any>[];
  }
>();
let sourcedBatchReport: Awaited<ReturnType<typeof checkGrowth>> | undefined;
const batchRuns: {
  scale: number;
  repetition: number;
  commands: number;
  tuples: number;
  tupleHomes: number[];
  changed: number;
  duplicates: number;
  noEffect: number;
  replayed: number;
  requestBytes: number;
  responseBytes: number;
}[] = [];

// Passive native auto_explain evidence from every client in the kernel/Access pool.
// Keep the complete observed plan for each statement/plan shape, plus every occurrence's
// work: relation totals alone cannot identify which lookup examined unrelated rows.
type NativePlan = { 'Query Text': string; Plan: Record<string, unknown> };
const nativeAgentScans: Record<string, unknown>[] = [];
let nativeRun:
  | Map<string, { plan: NativePlan; work: { rows: number; blocks: number; agents: Record<string, unknown>[] }[] }>
  | undefined;
let nativeFailures: { statement: string; code?: string; message: string; detail?: string }[] | undefined;
const observedClients = new WeakSet<PoolClient>();
function nativePlanShape(node: Record<string, unknown>): unknown {
  const fields = [
    'Node Type',
    'Relation Name',
    'Index Name',
    'Join Type',
    'Index Cond',
    'Filter',
    'Hash Cond',
    'Merge Cond',
    'Join Filter',
  ];
  return [
    ...fields.map((field) =>
      typeof node[field] === 'string'
        ? node[field].replace(/'(?:''|[^'])*'|\$\d+|\b\d+(?:\.\d+)?\b/g, '?')
        : node[field],
    ),
    ((node.Plans ?? []) as Record<string, unknown>[]).map(nativePlanShape),
  ];
}
function observeNativeClient(client: PoolClient): void {
  if (observedClients.has(client)) return;
  observedClients.add(client);
  // Observe rejected native promises without replacing their result or retrying.
  // Plans alone omit the failing statement of an aborted command attempt.
  const queryClient = client as unknown as { query: (...args: unknown[]) => unknown };
  const query = queryClient.query.bind(client);
  queryClient.query = (...args) => {
    const failures = nativeFailures;
    const result = query(...args);
    if (failures && result instanceof Promise) {
      const config = args[0] as string | { text?: string };
      const statement = typeof config === 'string' ? config : (config.text ?? '<unnamed>');
      void result.catch((error: { code?: string; message: string; detail?: string }) => {
        failures.push({
          statement,
          message: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        });
      });
    }
    return result;
  };
  client.on('notice', (notice) => {
    const marker = 'plan:\n';
    if (!nativeRun || !notice.message?.startsWith('duration:') || !notice.message.includes(marker)) return;
    const plan = JSON.parse(notice.message.slice(notice.message.indexOf(marker) + marker.length)) as NativePlan;
    const shape = JSON.stringify([plan['Query Text'], nativePlanShape(plan.Plan)]);
    const entry = nativeRun.get(shape) ?? { plan, work: [] };
    const { rows, blocks } = costOf({ statements: [], plans: [plan] });
    const agents: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node['Relation Name'] === 'account_agent_subject') {
        nativeAgentScans.push(node);
        agents.push(
          Object.fromEntries(
            ['Node Type', 'Index Cond', 'Filter', 'Actual Rows', 'Rows Removed by Filter', 'Actual Loops'].map(
              (key) => [key, node[key]],
            ),
          ),
        );
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
    };
    visit(plan.Plan);
    entry.work.push({ rows, blocks, agents });
    nativeRun.set(shape, entry);
  });
}

// Sourced bulk write / Active definition lookup / Request authorization Cost rows.
// These are data statements, as counted by costOf, across ALL pool connections.
// Control statements and catalog freshness probes keep their existing harness checks.
// The native actor has no assignment, memberships, role hits or governance reach.
// Each fresh subject has empty facts/summary/cover slots: no compact candidates to expand.
const sourcedStatementDerivation = {
  // Authentication + rate spend + batch Access (time/inverse/candidates/time/formula)
  // + active pointer and at most one cold release read.
  request: 1 + 1 + (1 + 1 + 1 + 1 + 1) + 2,
  // runCommand time; current actor admission; permission time/inverse/candidates;
  // Global anchor validation; final Access formula. The proof consumption is in memory.
  admission: 1 + 1 + (1 + 1 + 1) + 1 + 1,
  // The upstream Command and receipt derivation states counts per attempt and
  // allows three contention attempts. Own fixture partitions remain writable,
  // so this workload requires no fence-wait polls or cross-home deferred pass.
  maximumAttempts: 3,
  receipt: 1,
  // Both changed fence (position/outbox/basis/receipt) and noEffect fence
  // (partition/receipt only) are one statement. No extra finalizer is installed.
  fence: 1,
  // visibleSubject + redirect + source dedup; proposal revision + redirect + item
  // details; empty-slot operation + compact read + expansion fact; proposal revision
  // insert + subject update + candidate insert; source-candidate insert.
  changedBody: 2 + 1 + 3 + 3 + 3 + 1,
  noEffectBody: 2 + 1,
  changed: subjectsPerBatch * 3,
  noEffect: subjectsPerBatch * 3,
  replayed: 4,
  // One pre-dedup readFences per actual tuple home, shared by all three field groups.
  tupleHomes: tupleHomes.length,
  // probeCovers reads its partition once and probes EACH cover, including duplicates/replay.
  mediaHomes: tupleHomes.length,
  coverProbes: subjectsPerBatch * 2 + 1,
  documentInserts: subjectsPerBatch,
  mediaClaims: subjectsPerBatch,
};
const d = sourcedStatementDerivation;
const sourcedStatementFormula =
  'request + tupleHomes + mediaHomes + coverProbes + ' +
  'maximumAttempts * ((changed + noEffect + replayed) * (admission + receipt) + ' +
  '(changed + noEffect) * fence + changed * changedBody + noEffect * noEffectBody + ' +
  'documentInserts + mediaClaims)';
const sourcedStatementCeiling =
  d.request +
  d.tupleHomes +
  d.mediaHomes +
  d.coverProbes +
  d.maximumAttempts *
    ((d.changed + d.noEffect + d.replayed) * (d.admission + d.receipt) +
      (d.changed + d.noEffect) * d.fence +
      d.changed * d.changedBody +
      d.noEffect * d.noEffectBody +
      d.documentInserts +
      d.mediaClaims);

function source(externalId: string, field_group: Source['field_group']): Source {
  return {
    source: 'openlibrary',
    external_id: externalId,
    record_revision: 'growth-record-1',
    digest: hexDigest(`source:${externalId}`),
    converter_revision: 'growth-converter-1',
    field_group,
  };
}

function cited(property: string, content: unknown, url: string): BatchStatement {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }],
      },
    ],
  };
}

function summaryCommand(subjectId: string, externalId: string, key: string, text: string): BatchCommand {
  return {
    op: 'propose',
    key,
    source: source(externalId, 'summary'),
    subject: subjectId,
    rights,
    statement: cited(
      'schema:abstract',
      { language: 'ja', document: fromPlainText(text) },
      `https://openlibrary.org/${externalId}`,
    ),
  };
}

function fixtureCommands(fixture: WriteFixture, key: () => string): BatchCommand[] {
  return [
    {
      op: 'propose',
      key: key(),
      source: source(fixture.externalId, 'facts'),
      subject: fixture.subject,
      statement: cited('schema:inLanguage', 'ja', `https://openlibrary.org/${fixture.externalId}`),
    },
    summaryCommand(fixture.subject, fixture.externalId, key(), `Sourced summary ${fixture.subject}`),
    {
      op: 'propose',
      key: key(),
      source: source(fixture.externalId, 'cover'),
      subject: fixture.subject,
      statement: cited('schema:image', fixture.media, `https://openlibrary.org/${fixture.externalId}`),
    },
  ];
}

async function jsonRequest(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${access.bearer('importer')}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = `"${options.idempotencyKey}"`;
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function batch(commands: readonly BatchCommand[]) {
  return jsonRequest('POST', '/v1/subjects:batchWrite', { body: { commands } });
}

function successfulCommand(
  step: string,
  answer: { status: number; body: Record<string, any> },
  index: number,
  status: number,
) {
  const result = answer.body.results?.[index] as Record<string, any> | undefined;
  if (answer.status !== 200 || result?.status !== status)
    throw new Error(`${step} returned ${answer.status}/${result?.status}: ${JSON.stringify(answer.body)}`);
  return result;
}

async function externalIdInPartition(
  label: string,
  partition = batchPartition,
): Promise<{ externalId: string; route: number }> {
  for (let suffix = 0; suffix < 100_000; suffix++) {
    const externalId = `${label}-${suffix}`;
    const route = tupleRoute(routeKey, 'openlibrary', externalId);
    if (partitionOf(route) === partition) return { externalId, route };
  }
  throw new Error(`Could not find an Open Library tuple in partition ${partition}`);
}

function mediaRow(route: number, subjectId: string, mediaId: string, externalId: string): Row {
  const sourceRecord = {
    ...source(externalId, 'cover'),
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: `https://openlibrary.org/${externalId}` },
          },
        ],
      },
    ],
  };
  const checksum = hexDigest(`media:${mediaId}`);
  return {
    route,
    media_id: mediaId,
    container_id: subjectId,
    uploader_id: accountId,
    reservation_request_id: `growth-${externalId}`,
    purpose: 'cover',
    media_type: 'image/jpeg',
    byte_count: 96,
    declared_sha256: checksum,
    actual_byte_count: 96,
    sha256: checksum,
    state: 'available',
    decision: null,
    key: `m/${mediaId}/original`,
    claimed_at: null,
    transaction_id: randomUUID(),
    erased: false,
    collection_pending: false,
    source_url: `https://images.example.test/${encodeURIComponent(externalId)}.jpg`,
    credit: {
      rightsHolder: 'Growth fixture artist',
      via: { name: 'Open Library', url: 'https://openlibrary.org' },
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution'],
    },
    provenance: sourceRecord,
    taken_down: false,
    security_revision: 0,
    width: 12,
    height: 18,
    thumbhash: Buffer.from([1, 2, 3, 4]),
    average_color: '#336699',
    crop: null,
    focal_x: null,
    focal_y: null,
  };
}

function positionFor(name: string, ordinal: number): string {
  const prefix = BigInt(createHash('sha256').update(name).digest().readUIntBE(0, 5));
  return (1_000_000_000n + prefix * 10_000n + BigInt(ordinal)).toString();
}

function genericRows(name: string, ordinal: number, route: number): Readonly<Record<string, readonly Row[]>> {
  const seedAccount = newId(route);
  const subjectId = accountAgentId(seedAccount);
  const candidateId = newId(route);
  const penNameId = newId(route);
  const privateCandidateId = newId(route);
  const privateProperty = 'rezics:penNameOf';
  const privateSlot = relationSlotForApi(
    penNameId,
    privateProperty,
    bundledRelease.properties[privateProperty]!.relation,
    {
      target: subjectId,
    },
  );
  const documentId = newId(route);
  const mediaId = newId(route);
  const transactionId = randomUUID();
  const definition = {
    format: 'https://rezics.com/definitions/release/1',
    catalogue: { id: `https://growth.example.test/${encodeURIComponent(name)}/${ordinal}`, version: '1' },
    generator: { name: 'rezics-growth-fixture', version: '1' },
    prefixes: {},
    types: {},
    properties: {},
  } satisfies Release;
  const definitionDigest = releaseDigest(definition);
  const definitionRoute = ordinal + 1;
  const definitionHead =
    createHash('sha256').update(`${name}:activation-head`).digest().readUInt32BE(0) & 0x7fffffff || 1;
  const facts = itemFacts(subjectId, { labels: { en: `Growth ${name} ${ordinal}` } });
  const fieldSource = {
    source: 'openlibrary',
    external_id: `${name}-record-${ordinal}`,
    record_revision: 'growth-record-1',
    digest: 'd'.repeat(64),
    converter_revision: 'growth-converter-1',
    field_group: 'summary',
    references: [],
  };
  const statementDigest = 'a'.repeat(64);
  const slot = slotId(subjectId, 'schema:abstract');
  const statement = {
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { language: 'en', document: documentId, digest: 'e'.repeat(64) } },
    qualifiers: [],
    references: [],
  };
  const body = Buffer.from(`Growth fixture document ${name} ${ordinal}`);
  const subjectRevisionRows = [
    { revision: 1, kind: 'create', source: null },
    { revision: 2, kind: 'propose', source: fieldSource },
    { revision: 3, kind: 'reject', source: fieldSource },
    { revision: 4, kind: 'retract', source: fieldSource },
    { revision: 5, kind: 'adopt', source: null },
  ].map((revision) => ({
    route,
    subject_id: subjectId,
    ...revision,
    release: bundledDigest,
    recorded_transaction_id: randomUUID(),
  }));
  const hotFence = ordinal % rowsPerScale === 0;
  const fenceExternalId = hotFence ? `${name}-hot-fence-${ordinal}` : `${name}-fence-${ordinal}`;
  let fenceRoute = tupleRoute(routeKey, 'growth', fenceExternalId);
  if (hotFence) {
    let suffix = 0;
    while (partitionOf(fenceRoute) !== batchPartition) {
      const revised = `${name}-hot-fence-${ordinal}-${++suffix}`;
      fenceRoute = tupleRoute(routeKey, 'growth', revised);
    }
  } else {
    let suffix = 0;
    while (partitionOf(fenceRoute) === batchPartition) {
      const revised = `${name}-fence-${ordinal}-${++suffix}`;
      fenceRoute = tupleRoute(routeKey, 'growth', revised);
    }
  }
  const commandPosition = positionFor(name, ordinal);
  const outboxId = newId(route);
  const resourceId = newId(route);
  const denialResourceId = newId(route);
  const roleResourceId = newId(route);
  const groupId = newId((route + 16) % 65_536);
  const commonAccess = {
    route,
    subject_id: seedAccount,
    subject_role: '',
    action: 'subject:read',
    valid: '(,)',
    transaction_id: randomUUID(),
  };
  const sourceFenceGroup = (['facts', 'summary', 'cover'] as const)[ordinal % 3]!;
  const fenceSource = sourceFenceGroup === 'summary' ? 'growth' : 'growth';
  const fixtureSourceGroup = fieldSource.field_group;
  return {
    'semantic.context': [
      {
        route,
        context_id: newId(route),
        kind: 'community',
        labels: { en: `Growth context ${ordinal}` },
        recorded_transaction_id: randomUUID(),
      },
    ],
    'semantic.definition_release': [
      {
        route: definitionRoute,
        digest: definitionDigest,
        body: definition,
        recorded_transaction_id: randomUUID(),
      },
    ],
    'semantic.definition_activation': [
      {
        route: definitionRoute,
        head: definitionHead,
        digest: definitionDigest,
        recorded_transaction_id: randomUUID(),
      },
    ],
    'semantic.subject': [
      {
        route,
        subject_id: subjectId,
        type: 'schema:Person',
        recorded_transaction_id: transactionId,
        current_facts: facts.length,
        current_release: bundledDigest,
      },
      {
        route,
        subject_id: penNameId,
        type: 'schema:Person',
        recorded_transaction_id: transactionId,
        current_facts: 0,
        current_release: bundledDigest,
      },
    ],
    'semantic.account_agent_subject': [
      {
        route,
        account_route: route,
        subject_id: subjectId,
        account_id: seedAccount,
        agent_id: subjectId,
        verified: false,
        receipt_id: null,
      },
    ],
    'semantic.fact': facts.map((fact) => ({
      ...fact,
      route,
      subject_id: subjectId,
      recorded_transaction_id: transactionId,
    })),
    'semantic.revision': [...subjectRevisionRows, { ...subjectRevisionRows[0]!, subject_id: penNameId }],
    'semantic.candidate': [
      {
        route,
        subject_id: subjectId,
        candidate_id: candidateId,
        slot_id: slot,
        property: 'schema:abstract',
        rank: 'normal',
        statement,
        release: bundledDigest,
        revision: 2,
        origin: 'proposal',
        view_order: 0,
        relation: false,
      },
      {
        route,
        subject_id: penNameId,
        candidate_id: privateCandidateId,
        slot_id: privateSlot,
        property: privateProperty,
        rank: 'normal',
        statement: {
          rank: 'normal',
          value: { type: 'value', content: subjectId },
          qualifiers: [],
          references: [],
        },
        release: bundledDigest,
        revision: 1,
        origin: 'proposal',
        view_order: 0,
        relation: true,
      },
    ],
    // Seed every visibility relation the read probes so its plan is measured at population scale.
    'semantic.statement_disclosure': [
      {
        route,
        subject_id: penNameId,
        candidate_id: privateCandidateId,
        target_id: subjectId,
        account_id: seedAccount,
        property: privateProperty,
        source_order_key: '0pen name',
        target_order_key: '0person',
      },
    ],
    'semantic.acceptance': [
      {
        route,
        subject_id: subjectId,
        context_id: GLOBAL_CONTEXT,
        candidate_id: candidateId,
        head: 1,
        verdict: 'reject',
        revision: 3,
      },
      {
        route,
        subject_id: penNameId,
        context_id: GLOBAL_CONTEXT,
        candidate_id: privateCandidateId,
        head: 1,
        verdict: 'accept',
        revision: 1,
      },
    ],
    'semantic.acceptance_current': [
      {
        route,
        subject_id: subjectId,
        context_id: GLOBAL_CONTEXT,
        candidate_id: candidateId,
        slot_id: slot,
        head: 1,
        verdict: 'reject',
        revision: 3,
      },
      {
        route,
        subject_id: penNameId,
        context_id: GLOBAL_CONTEXT,
        candidate_id: privateCandidateId,
        slot_id: privateSlot,
        head: 1,
        verdict: 'accept',
        revision: 1,
      },
    ],
    'semantic.adoption': [
      {
        route,
        subject_id: subjectId,
        slot_id: slot,
        context_id: GLOBAL_CONTEXT,
        head: 1,
        mode: 'replace',
        selection: [],
        revision: 5,
      },
      {
        route,
        subject_id: penNameId,
        slot_id: privateSlot,
        context_id: GLOBAL_CONTEXT,
        head: 1,
        mode: 'replace',
        selection: [{ candidate: privateCandidateId, rank: 'normal' }],
        revision: 1,
      },
    ],
    'semantic.hidden_candidate': [
      { route, subject_id: subjectId, candidate_id: candidateId, visibility: 'hidden', security_revision: 1 },
    ],
    'semantic.retraction': [{ route, subject_id: subjectId, candidate_id: candidateId, revision: 4, references: [] }],
    'semantic.source_candidate': [
      {
        route,
        subject_id: subjectId,
        source: 'openlibrary',
        external_id: fieldSource.external_id,
        field_group: fixtureSourceGroup,
        statement_digest: statementDigest,
        candidate_id: candidateId,
      },
    ],
    'semantic.redirect': [
      {
        route,
        subject_id: subjectId,
        sequence: 1,
        target: `00000000-0000-8000-8000-${route.toString(16).padStart(4, '0')}00000000`,
        recorded_transaction_id: randomUUID(),
      },
    ],
    'content.imported_field': [
      {
        route,
        id: documentId,
        subject: subjectId,
        candidate: candidateId,
        revision: 2,
        body,
        body_sha256: digest(body),
        source: fieldSource,
        rights,
        language: 'en',
        availability: 'available',
      },
    ],
    'content.media': [mediaRow(route, subjectId, mediaId, `${name}-media-${ordinal}`)],
    'content.source_fences': [
      {
        route: fenceRoute,
        source: fenceSource,
        external_id: fenceExternalId,
        field_group: sourceFenceGroup,
        taken_down: false,
        security_revision: 1,
      },
    ],
    'core.receipt': [
      {
        partition_no: route >>> 4,
        principal_kind: 'account',
        principal_id: accountId,
        command_kind: 'subject.batch_propose',
        idempotency_key: `growth-${name}-${ordinal}`,
        request_digest: digest(`${name}:${ordinal}`),
        epoch: 1,
        position: commandPosition,
        transaction_id: transactionId,
        response: { status: 201, value: { candidate: candidateId, revision: 2 } },
      },
    ],
    'core.outbox': [
      {
        partition_no: route >>> 4,
        position: commandPosition,
        event_seq: 0,
        event_count: 1,
        epoch: 1,
        id: outboxId,
        type: 'com.rezics.statement.proposed.v1',
        subject: subjectId,
        data: { candidate: candidateId, revision: 2 },
      },
    ],
    'editorial.write_basis': [
      {
        partition_no: route >>> 4,
        transaction_id: transactionId,
        epoch: 1,
        position: commandPosition,
        principal_kind: 'account',
        principal_id: accountId,
        client_id: 'web',
        requested_by: null,
      },
    ],
    'access.account': [
      {
        route,
        account_id: seedAccount,
        kind: 'actor',
        state: 'active',
        transaction_id: seedAccount,
        membership_inverse_complete: true,
      },
    ],
    'access.membership_inverse': [
      {
        route,
        account_id: seedAccount,
        kind: 'organization',
        group_id: groupId,
        reservation_id: randomUUID(),
        transaction_id: randomUUID(),
      },
    ],
    'access.resource_grant': [{ ...commonAccess, resource_id: resourceId, subject_kind: 'identity' }],
    'access.resource_denial': [{ ...commonAccess, resource_id: denialResourceId, reason: 'resource' }],
    'access.resource_role_grant': [
      {
        route,
        resource_id: roleResourceId,
        subject_id: seedAccount,
        subject_role: '',
        subject_kind: 'identity',
        grant_role: 'growth.reader',
        valid: '(,)',
        transaction_id: randomUUID(),
      },
    ],
  };
}

function growthPopulation(name: string): Population {
  return {
    name,
    hotPartition: batchPartition,
    hotShare: 0.5,
    finish: async (admin) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, COALESCE((
           SELECT max(position) + 1000000 FROM editorial.write_basis b WHERE b.partition_no = p.partition_no
         ), 0))`,
      );
    },
    rows: ({ ordinal, route }) => genericRows(name, ordinal, route),
  };
}

function fixtureRows(fixtures: readonly WriteFixture[]): Population {
  return {
    name: `sourced-batch-fixtures-${fixtures[0]?.externalId ?? 'empty'}`,
    hotPartition: batchPartition,
    hotShare: 1,
    finish: async (admin) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, COALESCE((
           SELECT max(position) + 1000000 FROM editorial.write_basis b WHERE b.partition_no = p.partition_no
         ), 0))`,
      );
    },
    rows: ({ ordinal }) => {
      const fixture = fixtures[ordinal]!;
      const transactionId = randomUUID();
      const facts = itemFacts(fixture.subject, { labels: { en: `Bulk subject ${ordinal}` } });
      const position = positionFor(`sourced-fixture-${fixture.externalId}`, ordinal);
      return {
        'semantic.subject': [
          {
            route: fixture.route,
            subject_id: fixture.subject,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            current_facts: facts.length,
            current_release: bundledDigest,
          },
        ],
        'semantic.fact': facts.map((fact) => ({
          ...fact,
          route: fixture.route,
          subject_id: fixture.subject,
          recorded_transaction_id: transactionId,
        })),
        'semantic.revision': [
          {
            route: fixture.route,
            subject_id: fixture.subject,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transactionId,
            source: null,
          },
        ],
        'content.media': [mediaRow(fixture.route, fixture.subject, fixture.media, fixture.externalId)],
        'core.receipt': [
          {
            partition_no: fixture.route >>> 4,
            principal_kind: 'account',
            principal_id: accountId,
            command_kind: 'subject.create',
            idempotency_key: `sourced-fixture-${fixture.externalId}`,
            request_digest: digest(fixture.externalId),
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: { subject: fixture.subject },
          },
        ],
        'core.outbox': [
          {
            partition_no: fixture.route >>> 4,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(fixture.route),
            type: 'com.rezics.subject.created.v1',
            subject: fixture.subject,
            data: { id: fixture.subject },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: fixture.route >>> 4,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: accountId,
            client_id: 'web',
            requested_by: null,
          },
        ],
      };
    },
  };
}

function assertNoSemanticSequentialScans(report: Awaited<ReturnType<typeof checkGrowth>>): void {
  const scans = report.samples.flatMap(({ scale, cost }) =>
    Object.entries(cost.relations ?? {})
      .filter(([relation]) => relation.startsWith('semantic.'))
      .filter(([, relationCost]) => (relationCost.sequentialScans ?? 0) !== 0)
      .map(([relation, relationCost]) => ({ scale, relation, sequentialScans: relationCost.sequentialScans })),
  );
  expect(scans).toEqual([]);
}

function logSamples(report: Awaited<ReturnType<typeof checkGrowth>>): void {
  console.info(
    `GROWTH_SAMPLES ${JSON.stringify({
      check: report.name,
      samples: report.samples.map(({ scale, cost, repetitions }) => ({
        scale,
        ...cost,
        rowsIncludingRemoved: cost.rows,
        repetitions,
        ...(report.name.startsWith('a sourced bulk write')
          ? { batches: batchRuns.filter((run) => run.scale === scale) }
          : {}),
      })),
    })}`,
  );
}

async function sourceHistory(db: GrowthDatabase, subjectId: string, baseRevision: number, from: number, to: number) {
  if (from >= to) return;
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Expected a routed subject id');
  const result = await db.admin.query(
    `WITH input AS (
       SELECT $1::integer AS route, $2::uuid AS subject_id, $3::integer AS base_revision,
              $4::integer AS first_ordinal, $5::integer AS last_ordinal, $6::text AS release
     ), raw AS (
       SELECT input.*, ordinal,
              input.base_revision + ordinal * 2 + 1 AS proposal_revision,
              input.base_revision + ordinal * 2 + 2 AS retract_revision,
              md5(input.subject_id::text || ':source-history:' || ordinal::text) AS hash
       FROM input CROSS JOIN LATERAL generate_series(input.first_ordinal, input.last_ordinal - 1) AS series(ordinal)
     ), values AS (
       SELECT raw.*,
              (substr(hash, 1, 12) || '8' || substr(hash, 14, 3) || '8' || substr(hash, 18, 3) ||
               lpad(to_hex(route), 4, '0') || substr(hash, 25, 8))::text AS compact_id,
              jsonb_build_object(
                'source', 'openlibrary',
                'external_id', 'history-' || ordinal::text,
                'record_revision', 'growth-history-1',
                'digest', repeat('b', 64),
                'converter_revision', 'growth-converter-1',
                'field_group', 'summary',
                'references', '[]'::jsonb
              ) AS source
       FROM raw
     ), ids AS (
       SELECT values.*,
              (substr(compact_id, 1, 8) || '-' || substr(compact_id, 9, 4) || '-' ||
               substr(compact_id, 13, 4) || '-' || substr(compact_id, 17, 4) || '-' || substr(compact_id, 21, 12))::uuid AS candidate_id
       FROM values
     ), revision_rows AS (
       INSERT INTO semantic.revision
         (route, subject_id, revision, kind, release, recorded_transaction_id, source)
       SELECT route, subject_id, proposal_revision, 'propose', release, gen_random_uuid(), source FROM ids
       UNION ALL
       SELECT route, subject_id, retract_revision, 'retract', release, gen_random_uuid(), source FROM ids
       RETURNING route, subject_id, revision, kind
     ), candidate_rows AS (
       INSERT INTO semantic.candidate
         (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin, view_order)
       SELECT ids.route, ids.subject_id, ids.candidate_id, $7::uuid, 'schema:abstract', 'normal',
              jsonb_build_object(
                'property', jsonb_build_object('id', 'schema:abstract', 'data_type', 'document'),
                'value', jsonb_build_object('type', 'value', 'content',
                  jsonb_build_object('language', 'ja', 'document', ids.candidate_id::text, 'digest', repeat('c', 64))),
                'qualifiers', '[]'::jsonb, 'references', '[]'::jsonb
              ),
              ids.release, ids.proposal_revision, 'proposal', 0
       FROM ids JOIN revision_rows ON revision_rows.route = ids.route
         AND revision_rows.subject_id = ids.subject_id AND revision_rows.revision = ids.proposal_revision
         AND revision_rows.kind = 'propose'
       RETURNING route, subject_id, candidate_id
     ), retraction_rows AS (
       INSERT INTO semantic.retraction (route, subject_id, candidate_id, revision, "references")
       SELECT candidate_rows.route, candidate_rows.subject_id, candidate_rows.candidate_id, ids.retract_revision, '[]'::jsonb
       FROM candidate_rows JOIN ids USING (route, subject_id, candidate_id)
       JOIN revision_rows ON revision_rows.route = ids.route
         AND revision_rows.subject_id = ids.subject_id AND revision_rows.revision = ids.retract_revision
         AND revision_rows.kind = 'retract'
       RETURNING candidate_id
     )
     SELECT count(*)::int AS retracted FROM retraction_rows`,
    [route, subjectId, baseRevision, from, to, bundledDigest, slotId(subjectId, 'schema:abstract')],
  );
  if (result.rows[0]?.retracted !== to - from) throw new Error('Failed to seed source history');
}

async function prepareDisclosureSubject(): Promise<{
  subjectId: string;
  baseRevision: number;
  fencedExternalId: string;
}> {
  const createSource = await externalIdInPartition(`source-view-create-${randomUUID()}`);
  const created = await batch([
    {
      op: 'create',
      key: `source-view-create-${randomUUID()}`,
      source: source(createSource.externalId, 'facts'),
      subject: labelItem,
    },
  ]);
  const createResult = successfulCommand('create source-view subject', created, 0, 201);
  const subjectId = createResult.value.id as string;
  const subjectRoute = routeOf(subjectId);
  if (subjectRoute === null) throw new TypeError('Expected a routed subject id');
  await access.grant({ route: subjectRoute, id: subjectId }, 'importer', 'subject:read');

  const candidates = await Promise.all(
    [0, 1].map((index) => externalIdInPartition(`source-view-candidate-${randomUUID()}-${index}`)),
  );
  const proposal = await batch(
    candidates.map(({ externalId }, index) =>
      summaryCommand(subjectId, externalId, `source-view-proposal-${randomUUID()}`, `Visible source summary ${index}`),
    ),
  );
  const ids = candidates.map(
    (_, index) => successfulCommand('propose source-view candidate', proposal, index, 201).value.candidate as string,
  );
  for (const candidate of ids) {
    const accepted = await jsonRequest('POST', `/v1/subjects/${subjectId}/candidates/${candidate}:accept`, {
      body: { context: GLOBAL_CONTEXT, expected_head: null },
      idempotencyKey: randomUUID(),
    });
    if (accepted.status !== 200) throw new Error(`accept source-view candidate returned ${accepted.status}`);
  }
  const adopted = await jsonRequest('POST', `/v1/subjects/${subjectId}:adopt`, {
    body: {
      context: GLOBAL_CONTEXT,
      property: 'schema:abstract',
      mode: 'replace',
      selection: ids.map((candidate) => ({ candidate, rank: 'normal' })),
      expected_head: null,
    },
    idempotencyKey: randomUUID(),
  });
  if (adopted.status !== 200) throw new Error(`adopt source-view candidates returned ${adopted.status}`);

  const fencedExternalId = candidates[0]!.externalId;
  const fenced = await jsonRequest('POST', '/v1/sourceFences:takedown', {
    body: {
      source: 'openlibrary',
      externalId: fencedExternalId,
      fieldGroup: 'summary',
      reason: 'Growth fixture source fence.',
    },
    idempotencyKey: randomUUID(),
  });
  if (fenced.status !== 200) throw new Error(`take down source-view tuple returned ${fenced.status}`);
  const revision = await db.admin.query<{ revision: number }>(
    'SELECT max(revision)::int AS revision FROM semantic.revision WHERE route = $1 AND subject_id = $2',
    [subjectRoute, subjectId],
  );
  return { subjectId, baseRevision: revision.rows[0]!.revision, fencedExternalId };
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  db.pool.on('acquire', observeNativeClient);
  await bootstrapRelease(db.pool, bundledRelease);
  access = await createRealAccess(db.admin, { importer: accountId }, actions);
  await db.admin.query(
    'UPDATE access.account SET membership_inverse_complete = true WHERE route = $1 AND account_id = $2',
    [routeOf(accountId), accountId],
  );
  for (const action of [
    'subject:batch_write',
    'subject:create',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'source_fence:takedown',
  ])
    await access.grant(globalResource, 'importer', action);
  kernel = createKernel({
    pool: db.pool,
    access: access.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(37)]]) },
    routeKey,
    writeRate: growthWriteRate,
  });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow', async () => {
  const populationName = `semantic-sourced-bulk-growth-${randomUUID()}`;
  await checkGrowth(db, {
    name: 'a sourced bulk write at a fixed batch has constant rows and statements as subjects, documents and fences grow',
    rule: 'series',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    includeBackends: true,
    grow: async (database, scale, previous) => {
      const population = growthPopulation(populationName);
      await seed({ pool: database.pool, admin: database.admin }, population, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });

      const scaleIndex = scales.findIndex((value) => value === scale);
      if (scaleIndex < 0) throw new Error(`Unexpected growth scale ${scale}`);
      const fixtures = await Promise.all(
        Array.from({ length: warmupsAndRepetitions * fixturesPerBatch }, async (_, index) => {
          const found = await externalIdInPartition(
            `sourced-bulk-${scale}-${index}-${randomUUID()}`,
            tupleHomes[(index % fixturesPerBatch) % tupleHomes.length]!,
          );
          return {
            externalId: found.externalId,
            route: found.route,
            subject: newId(found.route),
            media: newId(found.route),
          };
        }),
      );
      await seed({ pool: database.pool, admin: database.admin }, fixtureRows(fixtures), {
        from: 0,
        to: fixtures.length,
      });
      for (let index = 0; index < warmupsAndRepetitions; index++) {
        const repetition = scaleIndex * warmupsAndRepetitions + index;
        const ownFixtures = fixtures.slice(index * fixturesPerBatch, (index + 1) * fixturesPerBatch);
        writeFixtures.set(repetition, ownFixtures);
        // Exact key/body replay is legal across requests, never twice in one
        // request (checkBatchWrite rejects duplicate command keys).
        const commands = [
          ...fixtureCommands(ownFixtures[subjectsPerBatch]!, randomUUID),
          fixtureCommands(ownFixtures[subjectsPerBatch + 1]!, randomUUID)[0]!,
        ];
        const prepared = await batch(commands);
        const results = commands.map((_, commandIndex) =>
          successfulCommand('prepare exact sourced replay', prepared, commandIndex, 201),
        );
        replayFixtures.set(repetition, { commands, results });
      }
      await database.admin.query('CHECKPOINT');
    },
    operation: async (_database, scale, repetition) => runSourcedBatch(scale, repetition),
    warmup: async (_database, scale, repetition) => runSourcedBatch(scale, repetition),
  }).then((report) => {
    sourcedBatchReport = report;
    logSamples(report);
    assertNoSemanticSequentialScans(report);
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(report.samples.every(({ cost }) => Boolean(cost.relations['content.source_fences']))).toBe(true);
  });
}, 120_000);

async function runSourcedBatch(scale: number, repetition: number): Promise<unknown> {
  const scaleIndex = scales.findIndex((value) => value === scale);
  const fixtures = writeFixtures.get(repetition);
  if (
    scaleIndex < 0 ||
    fixtures?.length !== fixturesPerBatch ||
    repetition < scaleIndex * warmupsAndRepetitions ||
    repetition >= (scaleIndex + 1) * warmupsAndRepetitions
  )
    throw new Error(`No spare sourced batch fixture for scale ${scale}, run ${repetition}`);
  const key = () => `sourced-${scale}-${repetition}-${randomUUID()}`;
  const originals: BatchCommand[] = [];
  const duplicates: BatchCommand[] = [];
  for (const fixture of fixtures.slice(0, subjectsPerBatch)) {
    // Rebuild summary snapshots with identical text and fresh block ids. Dedup must
    // recognize logical content, with unchanged source/record/converter revisions.
    originals.push(...fixtureCommands(fixture, key));
    duplicates.push(...fixtureCommands(fixture, key));
  }
  const replay = replayFixtures.get(repetition);
  if (!replay) throw new Error(`No prepared replay for run ${repetition}`);
  // 48 changes, 48 fresh-key unchanged contributions, four exact key/body replays.
  const commands = [...originals, ...duplicates, ...replay.commands];
  expect(BATCH_LIMIT).toBe(100);
  expect(commands).toHaveLength(100);
  const homes = [
    ...new Set(
      commands.map((command) => partitionOf(tupleRoute(routeKey, command.source.source, command.source.external_id))),
    ),
  ].sort((left, right) => left - right);
  expect(homes).toEqual(tupleHomes);
  const tuples = new Set(
    commands.map(({ source }) => JSON.stringify([source.source, source.external_id, source.field_group])),
  ).size;
  expect(tuples).toBe(52);
  console.info(
    `SOURCED_STATEMENT_BOUND ${JSON.stringify({
      formula: sourcedStatementFormula,
      operands: sourcedStatementDerivation,
      ceiling: sourcedStatementCeiling,
    })}`,
  );
  nativeRun = new Map();
  nativeFailures = [];
  let answer: Awaited<ReturnType<typeof batch>>;
  try {
    answer = await batch(commands);
  } finally {
    // Lossless compression keeps complete native plans and every occurrence's work
    // in the remote log without spending the result transport on repeated SQL text.
    const evidence = JSON.stringify({
      scale,
      repetition,
      statements: [...nativeRun.values()],
      failures: nativeFailures,
    });
    console.info(`SOURCED_NATIVE_PLANS_GZIP ${Buffer.from(Bun.gzipSync(Buffer.from(evidence))).toString('base64')}`);
    nativeRun = undefined;
    nativeFailures = undefined;
  }
  // Preserve native failures (including every rejected command) for owner diagnosis.
  console.info(`SOURCED_BATCH_RESULTS ${JSON.stringify({ scale, repetition, body: answer.body })}`);
  if (answer.status !== 200) throw new Error(`sourced batch returned ${answer.status}: ${JSON.stringify(answer.body)}`);
  expect(answer.body.results).toHaveLength(100);
  for (let index = 0; index < commands.length; index++) {
    const expectedStatus = index >= 48 && index < 96 ? 200 : 201;
    const result = successfulCommand('sourced batch command', answer, index, expectedStatus);
    expect(result.key).toBe(commands[index]!.key);
    expect(typeof result.value.candidate).toBe('string');
    if (index < 48) expect(result.value.revision).toBe(2 + (index % 3));
    else if (index < 96) {
      expect(result.value.candidate).toBe(answer.body.results[index - 48].value.candidate);
      expect(result.value.revision).toBe(4);
      expect(commands[index]!.key).not.toBe(commands[index - 48]!.key);
    } else expect(result).toEqual(replay.results[index - 96]!);
  }
  batchRuns.push({
    scale,
    repetition,
    commands: commands.length,
    tuples,
    tupleHomes: homes,
    changed: 48,
    duplicates: 48,
    noEffect: answer.body.results.filter((result: { status: number }) => result.status === 200).length,
    replayed: 4,
    requestBytes: Buffer.byteLength(JSON.stringify({ commands })),
    responseBytes: Buffer.byteLength(JSON.stringify(answer.body)),
  });
  return answer.body;
}

test('the actual fixed batch has100 commands with several tuple homes and duplicates and stays within the existing derived statement bound', () => {
  expect(sourcedBatchReport).toBeDefined();
  expect(sourcedStatementCeiling).toBe(5138);
  expect(batchRuns).toHaveLength(scales.length * warmupsAndRepetitions);
  for (const run of batchRuns) {
    expect(run.commands).toBe(100);
    expect(run.tupleHomes).toEqual(tupleHomes);
    expect(run.duplicates).toBe(48);
    expect(run.noEffect).toBe(48);
    expect(run.replayed).toBe(4);
  }
  for (const sample of sourcedBatchReport!.samples) {
    expect(sample.repetitions).toHaveLength(5);
    for (const cost of sample.repetitions) expect(cost.statements).toBeLessThanOrEqual(sourcedStatementCeiling);
  }
});

test("source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow", async () => {
  const fixture = await prepareDisclosureSubject();
  const populationName = `semantic-source-disclosure-growth-${randomUUID()}`;
  const report = await checkGrowth(db, {
    name: "source-fence disclosure on a subject view has constant rows and statements as subjects, fences and the subject's history grow",
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (database, scale, previous) => {
      const population = growthPopulation(populationName);
      await seed({ pool: database.pool, admin: database.admin }, population, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });
      await sourceHistory(
        database,
        fixture.subjectId,
        fixture.baseRevision,
        previous * rowsPerScale,
        scale * rowsPerScale,
      );
      await database.admin.query('CHECKPOINT');
    },
    operation: async () => {
      const answer = await jsonRequest('GET', `/v1/subjects/${fixture.subjectId}`);
      if (answer.status !== 200)
        throw new Error(`subject view returned ${answer.status}: ${JSON.stringify(answer.body)}`);
      expect(answer.body.subject.statements['schema:abstract']).toHaveLength(1);
      return answer.body;
    },
  });
  assertNoSemanticSequentialScans(report);
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ cost }) => Boolean(cost.relations['content.source_fences']))).toBe(true);
  logSamples(report);
});

test('the native100 sourced batch probes account agents by route and subject key', () => {
  expect(nativeAgentScans.length).toBeGreaterThan(0);
  for (const node of nativeAgentScans) {
    expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(node['Index Cond']).toMatch(/route =/);
    expect(node['Index Cond']).toMatch(/subject_id =/);
    expect(Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(1);
  }
});

// The remote runner retains stdout even when series classification rejects the
// report. Export the existing profile before its disposable workspace is removed.
afterAll(async () => {
  const path = process.env.GROWTH_PROFILE;
  if (!path) return;
  const profile = Bun.file(path);
  if (!(await profile.exists())) return;
  for (const line of (await profile.text()).trim().split('\n')) {
    if (line) console.info(`SOURCED_GROWTH_PROFILE ${line}`);
  }
});
