import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterDocument } from '@rezics/filter';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import { accessCheck, accessCommandAuthorization, type Access, type Actor } from '../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { relationSlotForApi } from '../../src/semantic/item.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { adoptCandidates, decideCandidate, proposeStatement } from '../../src/semantic/candidates.ts';
import { moderateStatement, moderateSubject } from '../../src/semantic/moderation.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { FactClause } from '../../src/search/disclosure/check.ts';
import type { IndexedStatement, RelationFacetMatch } from '../../src/search/source.ts';
import { createRealAccess } from './real-access.ts';

// Consumer contract only. Resolve production dynamically after commands, selection and Access succeed.
export type LeafWork = Readonly<{
  keys: number;
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
}>;
export type LeafProgress = Readonly<{
  basis: string;
  phase: 'compact' | 'selection' | 'witness';
  valueOrdinal: number;
  after: string | null;
}>;
export type SelectedLeafFact = Readonly<{
  witness: string;
  statement: IndexedStatement;
  release: string;
  revision: number;
  rank: 'normal' | 'preferred';
}>;
export type LeafCoverage = { kind: 'selection' | 'empty_pair'; basis: string };
export type LeafEvidence =
  | { state: 'basis_changed' | 'not_ready'; usage: LeafWork }
  | {
      state: 'current';
      basis: string;
      type: string | null;
      facts: readonly SelectedLeafFact[];
      coverage: LeafCoverage | null;
      progress: LeafProgress | null;
      usage: LeafWork;
    };
export type LeafRequest = Readonly<{
  subject: string;
  leaf: FactClause;
  after: LeafProgress | null;
  revalidate: string | null;
  budget: LeafWork;
}>;
export type LeafOptions = Readonly<{
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline: number;
  nativeT?: AuthoritativeTime;
}>;
export type LeafReader = (pool: Pool, request: LeafRequest, options: LeafOptions) => Promise<LeafEvidence>;
export async function requiredExport<T>(relative: string, name: string): Promise<T> {
  const path = new URL(`../../src/${relative}.ts`, import.meta.url);
  let exports: Record<string, unknown> = {};
  try {
    exports = await import(path.href);
  } catch (error) {
    if (await Bun.file(path).exists()) throw error;
    if (!(error instanceof Error) || !/Cannot find module|ModuleNotFound/.test(error.message)) throw error;
  }
  expect(
    exports[name],
    `Missing additive ${relative}.${name}; real commands, selected facts and Access completed`,
  ).toBeFunction();
  return exports[name] as T;
}
export const leafReader = () => requiredExport<LeafReader>('semantic/scope-leaf-evidence', 'readScopeLeafEvidence');
// Test-only certificate bridge. The actual Scope consumer mapping is separately Search-owned.
// Resolve pure shared ports only after the native command/selection/Access baseline and reader.
export type CurrentEvaluator = (filter: FilterDocument, evidence: readonly LeafEvidence[]) => RelationFacetMatch;
type CurrentFilterPlan = {
  leaves: readonly FactClause[];
  evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch;
};
export async function currentEvaluator(): Promise<CurrentEvaluator> {
  const compile = await requiredExport<(filter: FilterDocument) => CurrentFilterPlan>(
    'search/current-filter-plan',
    'compileCurrentFilter',
  );
  const holdsType = await requiredExport<(type: string, clause: Extract<FactClause, { facet: 'type' }>) => boolean>(
    'search/current-leaf',
    'holdsCurrentType',
  );
  const holdsStatements = await requiredExport<
    (statements: readonly IndexedStatement[], clause: Extract<FactClause, { facet: 'statement' }>) => boolean
  >('search/current-leaf', 'holdsCurrentStatements');
  return (filter, evidence) => {
    const plan = compile(filter);
    expect(evidence).toHaveLength(plan.leaves.length);
    return plan.evaluate(
      plan.leaves.map((clause, index): RelationFacetMatch => {
        const leaf = evidence[index]!;
        if (leaf.state !== 'current') return 'not_proven';
        const matches =
          clause.facet === 'type'
            ? leaf.type !== null && holdsType(leaf.type, clause)
            : holdsStatements(
                leaf.facts.map((fact) => fact.statement),
                clause,
              );
        if (matches) return true;
        return leaf.coverage !== null && leaf.coverage.basis === leaf.basis ? false : 'not_proven';
      }),
    );
  };
}
export type IdentityBasis = { digest: string };
export type BasisReader = (
  pool: Pool,
  options: { deadline: number },
) => Promise<{ state: 'ready'; basis: IdentityBasis } | { state: 'not_ready' }>;
export type TerminalReader = (
  pool: Pool,
  id: string,
  options: { access: Access; actor: Actor; deadline: number; nativeT?: AuthoritativeTime },
) => Promise<{ state: 'ready'; id: string; components: readonly unknown[] } | { state: 'not_ready' } | null>;
export type AliasReader = (
  pool: Pool,
  options: { terminal: string; basis: IdentityBasis; after: string | null; limit: number; deadline: number },
) => Promise<
  | { state: 'not_ready' | 'basis_changed' }
  | {
      state: 'ready';
      originals: readonly string[];
      after: string | null;
      exhausted: boolean;
      examined: number;
      points: number;
    }
>;
export const deadline = () => Date.now() + 30_000;
export const routeKey = new Uint8Array(32).fill(83);
export const stepBudget = (): LeafWork => ({
  keys: 17,
  points: 512,
  witnesses: 16,
  rows: 2048,
  bytes: 262144,
  emptySeeks: 512,
});
export const typeLeaf: FactClause = { facet: 'type', values: ['schema:Book'] };
export const languageLeaf: FactClause = { facet: 'statement', property: 'schema:inLanguage', values: ['ja'] };
export const snak = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
export const statement = (property: string, content: unknown, qualifiers: ReturnType<typeof snak>[] = []) => ({
  ...snak(property, content),
  qualifiers,
});
const release: Release = structuredClone(bundledRelease);
release.catalogue = { id: 'https://example.test/current-leaf-evidence', version: '1' };
release.prefixes.ex = 'https://example.test/';
release.filters = {};
const property = (id: string, extra: object = {}) => ({
  iri: `https://example.test/${id.slice(3)}`,
  labels: { en: id },
  mappings: [],
  datatype: 'wikibase-item' as const,
  multivalued: true,
  qualifiers: [],
  targets: ['schema:Person'],
  value: valueSchema('wikibase-item'),
  ...extra,
});
release.properties['ex:key'] = property('ex:key');
release.properties['ex:credit'] = property('ex:credit', {
  qualifiers: ['ex:key'],
  relation: { group: 'credit', inverse: 'none', order: 'name', slotKey: 'ex:key' },
});
release.types['schema:Person']!.facets = [
  ...new Set([...(release.types['schema:Person']!.facets ?? []), 'rezics:penNameOf']),
];
release.properties['schema:recipeYield']!.qualifiers = ['ex:key'];
release.types['schema:Recipe']!.facets = [
  ...new Set([...release.types['schema:Recipe']!.facets!, 'schema:recipeYield', 'schema:datePublished']),
];
release.types['schema:Book']!.properties = [...release.types['schema:Book']!.properties, 'ex:credit'].sort();
release.types['schema:Book']!.facets = [...new Set([...release.types['schema:Book']!.facets!, 'ex:credit'])];
export const nativeRelease = { digest: releaseDigest(release), release };
const digest = (key: string) => createHash('sha256').update(key).digest();
const resource = (id: string) => ({ route: routeOf(id)!, id });

export async function leafFixture(pool: Pool, admin: Pool) {
  const actions = [
    'subject:create',
    'subject:read',
    'subject:merge',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
    'subject:batch_write',
    'source_fence:takedown',
  ];
  const real = await createRealAccess(admin, { editor: newId(0x7410), reader: newId(0x7420) }, actions);
  const access = real.access({
    actions: new Map(actions.map((action) => [action, { anonymous: action === 'subject:read' }])),
  });
  for (const action of actions.filter((action) => action !== 'subject:read'))
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(pool, release);
  const editor = await access.authenticate(real.bearer('editor'), { pool, deadline: deadline() });
  const reader = await access.authenticate(real.bearer('reader'), { pool, deadline: deadline() });
  if (editor.kind !== 'account') throw new Error('Expected authenticated real editor');
  async function auth(action: string) {
    return accessCommandAuthorization(
      access,
      editor,
      action,
      { route: 0, id: GLOBAL_CONTEXT },
      { pool, deadline: deadline() },
      () => new Error(`Denied native ${action}`),
    );
  }
  async function command(action: string) {
    const key = randomUUID();
    return {
      actor: editor,
      idempotencyKey: key,
      digest: digest(key),
      authorization: await auth(action),
      deadline: deadline(),
    };
  }
  async function create(type = 'schema:Person', statements: Record<string, unknown[]> = {}, route = 0x7500) {
    const target = { route, id: newId(route) };
    const result = await createSubject(pool, {
      ...(await command('subject:create')),
      target,
      release: nativeRelease,
      item: { type, labels: { en: 'Native current leaf fixture' }, statements },
    });
    expect(result.subject.id).toBe(target.id);
    return target.id;
  }
  async function propose(
    subject: string,
    property: string,
    content: unknown,
    qualifiers: ReturnType<typeof snak>[] = [],
  ) {
    const result = await proposeStatement(pool, {
      ...(await command('statement:propose')),
      actor: editor,
      subject,
      release: nativeRelease,
      statement: {
        ...statement(property, content, qualifiers),
        references: [{ parts: [snak('schema:url', 'https://example.test/fact')] }],
      },
    });
    return result.candidate;
  }
  async function accept(subject: string, candidate: string) {
    await decideCandidate(pool, {
      ...(await command('context:accept')),
      subject,
      candidate,
      context: GLOBAL_CONTEXT,
      decision: 'accept',
      expectedHead: null,
    });
  }
  async function adopt(
    subject: string,
    property: string,
    candidates: string[],
    expectedHead: number | null,
    extra: { target?: string; key?: string; rank?: 'normal' | 'preferred' } = {},
  ) {
    const { rank = 'normal', ...rest } = extra;
    const slot = relationSlotForApi(subject, property, release.properties[property]?.relation, rest);
    return (
      await adoptCandidates(pool, {
        ...(await command('context:adopt')),
        subject,
        property,
        release: nativeRelease,
        context: GLOBAL_CONTEXT,
        mode: 'replace',
        slot,
        selection: candidates.map((candidate) => ({ candidate, rank })),
        expectedHead,
      })
    ).adoption.head;
  }
  async function hideCandidate(subject: string, candidate: string, action: 'hide' | 'restore' = 'hide') {
    await moderateStatement(pool, {
      ...(await command(action === 'hide' ? 'moderation:hide' : 'moderation:takedown')),
      subject,
      candidate,
      action,
      body: { reason: 'Native evidence mutation' },
    });
  }
  async function hideSubject(subject: string, action: 'hide' | 'restore' = 'hide') {
    await moderateSubject(pool, {
      ...(await command(action === 'hide' ? 'moderation:hide' : 'moderation:takedown')),
      subject,
      action,
      body: { reason: 'Native target mutation' },
    });
  }
  function options(): LeafOptions {
    return { access, actor: reader, routeKey, deadline: deadline() };
  }
  function request(subject: string, leaf: FactClause, after: LeafProgress | null = null): LeafRequest {
    return { subject, leaf, after, revalidate: null, budget: stepBudget() };
  }
  async function baseline() {
    const book = await create('schema:Book', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
    const check = await accessCheck(
      access,
      reader,
      'subject:read',
      {
        ...resource(book),
        eligibility: subjectReadEligibility(resource(book)),
      },
      { pool, deadline: deadline() },
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      expect(await check(client)).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const snapshot = await subjectSource(pool, routeKey).read(partitionOf(routeOf(book)!), [book]);
    expect(snapshot.subjects).toHaveLength(1);
    expect(snapshot.subjects[0]!.type).toBe('schema:Book');
    expect(snapshot.subjects[0]!.statements).toContainEqual({
      property: 'schema:inLanguage',
      value: 'ja',
      facet: { kind: 'code' },
    });
    expect(real.readChecks.some((entry) => entry.resource.id === book && entry.action === 'subject:read')).toBe(true);
    return book;
  }
  async function witnesses(subject: string, target: string, count: number) {
    const entries: { candidate: string; key: string; head: number }[] = [];
    for (let index = 0; index < count; index++) {
      const key = await create();
      const candidate = await propose(subject, 'ex:credit', target, [snak('ex:key', key)]);
      await accept(subject, candidate);
      const head = await adopt(subject, 'ex:credit', [candidate], null, { target, key });
      entries.push({ candidate, key, head });
    }
    return entries.sort((a, b) => (a.candidate < b.candidate ? -1 : 1));
  }
  return {
    pool,
    admin,
    real,
    access,
    editor,
    reader,
    create,
    propose,
    accept,
    adopt,
    hideCandidate,
    hideSubject,
    command,
    options,
    request,
    baseline,
    witnesses,
  };
}
export type LeafFixture = Awaited<ReturnType<typeof leafFixture>>;
export function current(result: LeafEvidence) {
  expect(result.state).toBe('current');
  if (result.state !== 'current') throw new Error('Expected current native leaf evidence');
  expect(result.basis).toMatch(/^[a-f0-9]{64}$/);
  if (result.coverage) expect(result.coverage.basis).toBe(result.basis);
  if (result.progress) expect(result.progress.basis).toBe(result.basis);
  for (const fact of result.facts) {
    expect(fact.witness.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(fact.witness)).toBeLessThanOrEqual(128);
    expect(Object.keys(fact).sort()).toEqual(['rank', 'release', 'revision', 'statement', 'witness']);
    expect(Object.keys(fact.statement).every((key) => ['property', 'value', 'facet', 'qualifiers'].includes(key))).toBe(
      true,
    );
    expect(fact.revision).toBeGreaterThan(0);
    expect(fact.release).toBeString();
  }
  return result;
}
export function accounted(result: LeafEvidence, budget: LeafWork) {
  expect(Object.keys(result.usage).sort()).toEqual(Object.keys(budget).sort());
  for (const key of Object.keys(budget) as (keyof LeafWork)[]) {
    expect(Number.isSafeInteger(result.usage[key]), key).toBe(true);
    expect(result.usage[key], key).toBeGreaterThanOrEqual(0);
    expect(result.usage[key], key).toBeLessThanOrEqual(budget[key]);
  }
  expect(result.usage.keys).toBeGreaterThanOrEqual(result.usage.witnesses);
  if (result.state === 'current') {
    expect(result.usage.witnesses).toBeGreaterThanOrEqual(result.facts.length);
    expect(result.usage.keys).toBeGreaterThanOrEqual(result.facts.length);
  }
}
export async function finishWitnessRepair(pool: Pool, subject: string) {
  const factory = await requiredExport<
    (options: { pool: Pool; routeKey: Uint8Array; pageSize: number; consumer: string }) => {
      run(partition: number): Promise<{ status: 'read' | 'busy'; examined: number; done: boolean }>;
      stop(): Promise<void>;
    }
  >('semantic/search-source', 'relationFacetRebuilds');
  const consumer = `leaf_${randomUUID().replaceAll('-', '')}`;
  for (let page = 0; page < 20000; page++) {
    const runner = factory({ pool, routeKey, pageSize: 16, consumer });
    try {
      const result = await runner.run(partitionOf(routeOf(subject)!));
      expect(result.examined).toBeLessThanOrEqual(16);
      if (result.done) return;
    } finally {
      await runner.stop();
    }
  }
  throw new Error('Finite native witness repair did not finish');
}
