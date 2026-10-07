import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { exportRoutes } from '../src/routes/exports.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { readSemanticDisclosure, SEMANTIC_DISCLOSURE_LIMIT }
  from '../src/modules/access/semantic-disclosure.ts';
import { PolicyUnavailable } from '../src/modules/access/policy-errors.ts';

test('G-539: summaries cannot bind an unrelated Work and semantic disclosure has one Access owner', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const summary = source('modules/media/summary.ts');
  expect(summary).toContain('IF(${workType} && BOUND(?work), EXISTS');
  expect(summary).not.toContain('row.public = false');
  expect(summary).not.toContain('rv:semanticWork');
  expect(summary).toContain('row.public = publicSemantics.has(reference)');
  const batch = source('modules/media/access-batch.ts');
  expect(batch).toContain('return readSemanticDisclosure');
  expect(batch).not.toContain("resources, 'semantic:read:', 'semantic.read'");
  expect(batch).not.toContain('rv:semanticHead');
  expect(source('modules/access/admission.ts')).toContain('await publicSemantics(');
  expect(source('routes/resources.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
  expect(source('routes/media.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
  expect(source('routes/search.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
});

test('G-539: an exact semantic export cannot substitute ordinary Work read authority for a history grant', async () => {
  const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    if (!query.includes('ASK')) throw new Error('denied export read historical bytes');
    return { boolean: true };
  };
  let checkedRevision: string | undefined;
  let workReads = 0;
  let cancelled = false;
  const app = exportRoutes({ environment: { fuseki: graph, objectDirectory: '.temp/g-539-export',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
  account: { verify: async () => ({ issuer: 'https://account.test', subject: 'reader' }) },
  access: {
    register: async () => ({ id: 'admission', principalId: 'principal', state: 'claimed', dispatchEligible: true }),
    recordGraphOutcome: async () => {},
    canReadWork: async () => { workReads++; return true; },
    canReadSemanticResource: async (_principal: unknown, _actor: unknown, _resource: string,
      exactRevision?: string) => { checkedRevision = exactRevision; return false; },
  }, exports: { readByAdmission: async () => null, cancel: async () => { cancelled = true; return {}; } },
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.test/v1/exports', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'old-semantic-export' },
    body: JSON.stringify({ profile: 'export-create-v1', actingSubject: resource, useScope: 'excerpt',
      selection: { kind: 'semantic-revision', reference: revision, resource,
        expectedPosition: { dataEpoch: 'epoch', sequence: '1' } } }) }));
  expect(response.status).toBe(404);
  expect(checkedRevision).toBe(revision);
  expect(workReads).toBe(0);
  expect(cancelled).toBe(true);
});

const semanticId = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const semanticActor = semanticId(1), privateCollection = semanticId(2), publicResource = semanticId(3);
const semanticPrincipal: VerifiedPrincipal = { issuer: 'https://account.test', subject: 'curator', emailVerified: true };

function semanticFixture() {
  const state = { recoveryOpen: true, principalActive: true, member: true,
    subjectActive: true, controlActive: true, baselineActive: true,
    collectionActive: true, curator: semanticActor, closed: false,
    policy: false, policyEnded: false, gate: false, semanticGrant: false, workGrant: false,
    representationActive: true, grantActive: true, public: new Set<string>() };
  const sql: Array<{ query: string; values: unknown[] }> = [], graphReads: string[] = [];
  let connected = 0, released = 0, transaction = false, recoveryFenced = false;
  const client = { release: () => { released++; }, query: async (query: string, values: unknown[] = []) => {
    sql.push({ query, values: structuredClone(values) });
    if (query === 'BEGIN') { expect(transaction).toBe(false); transaction = true; return { rows: [], rowCount: 0 }; }
    expect(transaction).toBe(true);
    if (query === 'COMMIT' || query === 'ROLLBACK') {
      transaction = false; return { rows: [], rowCount: 0 };
    }
    if (query.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (query.includes('FROM access.recovery_fence')) {
      expect(query).toContain('FOR SHARE'); recoveryFenced = true;
      return { rows: [{ open: state.recoveryOpen, generation: '1' }], rowCount: 1 };
    }
    expect(recoveryFenced).toBe(true);
    if (query.includes('WHERE NOT EXISTS (SELECT 1 FROM access.scope_gate')) {
      expect(query).toContain('ended_at IS NULL');
      const candidates = values[0] as string[];
      const rows = candidates.filter(resource => resource !== privateCollection
        || !state.closed && (!state.policy || state.policyEnded)).map(resource => ({ resource }));
      return { rows, rowCount: rows.length };
    }
    if (query.includes('SELECT id FROM access.principal')) {
      expect(query).toContain('AND active FOR SHARE');
      return { rows: state.principalActive ? [{ id: 'principal' }] : [], rowCount: state.principalActive ? 1 : 0 };
    }
    if (query.includes('FROM access.scope_gate WHERE id = ANY')) {
      expect(values[0]).toEqual((values[0] as string[]).filter(scope => scope.startsWith('semantic:read:')));
      const rows = (values[0] as string[]).filter(scope => scope === `semantic:read:${privateCollection}`
        && (state.gate || state.closed)).map(id => ({ id, open: !state.closed }));
      return { rows, rowCount: rows.length };
    }
    if (query.includes('FROM access.policy WHERE scope_id = ANY')) {
      // Ended policies remain installed and continue to suppress the baseline.
      expect(query).not.toContain('ended_at');
      const rows = state.policy ? [{ scope_id: `semantic:read:${privateCollection}` }] : [];
      return { rows, rowCount: rows.length };
    }
    if (query.includes('CROSS JOIN (VALUES')) {
      expect(query).toContain("('semantic:read:', 'semantic.read')");
      expect(query).not.toContain('work.read'); expect(query).not.toContain('work:read:');
      expect(query).toContain('AND gate.open'); expect(query).toContain('subject.active');
      expect(query).toContain('valid_until > clock_timestamp()');
      expect(query).toContain('FOR SHARE OF gate, subject');
      const grantedActions = [...(state.semanticGrant ? ['semantic.read'] : []),
        ...(state.workGrant ? ['work.read'] : [])];
      const rows = (values[2] as string[]).filter(resource => resource === privateCollection && state.gate
        && !state.closed && state.subjectActive && state.representationActive && state.grantActive
        && grantedActions.some(action => query.includes(`'${action}'`))).map(resource => ({ resource }));
      return { rows, rowCount: rows.length };
    }
    if (query.includes('SELECT id FROM access.scope_gate WHERE id = $1')) return { rows: [], rowCount: 0 };
    if (query.includes('access.read_platform_permissions')) return { rows: [], rowCount: 0 };
    if (query.includes('FROM access.agent_provision')) {
      expect(values.slice(0, 2)).toEqual(['principal', semanticActor]);
      for (const condition of ["a.agent_kind = 'person'", "a.state = 'active'", 'p.active', 'b.active',
        "s.kind = 'agent'", "r.action = 'agent.control'", 'r.active', 'r.valid_until > clock_timestamp()',
        'FOR SHARE OF p, r, s, b']) expect(query).toContain(condition);
      const rows = state.member && state.subjectActive && state.controlActive && state.baselineActive
        ? [{ policy_generation: '1', provision_id: 'provision', representation_id: 'control' }] : [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected semantic disclosure SQL: ${query}`);
  } };
  const pool = { connect: async () => { connected++; return client; }, query: async () => {
    throw new Error('Semantic baseline escaped its fenced PoolClient');
  } } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    expect(transaction).toBe(true); expect(recoveryFenced).toBe(true); graphReads.push(query);
    if (query.includes('VALUES ?resource')) {
      return { results: { bindings: [...state.public].filter(resource => query.includes(`<${resource}>`))
        .map(value => ({ resource: { type: 'uri', value } })) } };
    }
    if (query.includes('SELECT ?resource ?admission ?receipt ?digest')) {
      expect(query).toContain('space:create:root');
      return { results: { bindings: [] } };
    }
    if (query.includes('SELECT DISTINCT ?resource')) {
      expect(query).toContain(`rv:curator <${semanticActor}>`);
      expect(query).toContain('rv:collectionState rv:Active');
      expect(query).toContain('VALUES ?kind { rv:Collection rv:DynamicCollection }');
      expect(query).not.toContain('rv:mainVersion');
      const visible = state.collectionActive && state.curator === semanticActor && query.includes(`<${privateCollection}>`);
      return { results: { bindings: visible ? [{ resource: { type: 'uri', value: privateCollection } }] : [] } };
    }
    throw new Error(`Unexpected semantic disclosure graph read: ${query}`);
  };
  return { state, pool, graph, sql, graphReads, counts: () => ({ connected, released, transaction }),
    read: (principal: VerifiedPrincipal | null = semanticPrincipal, refs: readonly string[] = [privateCollection]) =>
      readSemanticDisclosure({ pool, graph }, principal, principal ? semanticActor : null, refs) };
}

test('semantic batches keep a verified private curator granted within one recovery-fenced transaction', async () => {
  const f = semanticFixture(); f.state.public.add(publicResource);
  const disclosure = await f.read(semanticPrincipal, [privateCollection, publicResource, privateCollection]);
  expect(disclosure.public).toEqual(new Set([publicResource]));
  expect(disclosure.granted).toEqual(new Set([privateCollection]));
  expect(f.counts()).toEqual({ connected: 1, released: 1, transaction: false });
  expect(f.graphReads).toHaveLength(3);
  expect(f.sql.filter(row => row.query.includes('FROM access.agent_provision'))).toHaveLength(1);
  expect(f.sql.at(-1)?.query).toBe('COMMIT');
});

test('semantic curator baseline preserves closed, ended-policy, member and current Collection denials', async () => {
  for (const restriction of ['closed', 'policy', 'ended-policy', 'unverified', 'nonmember', 'inactive',
    'noncurator', 'subject-inactive', 'control-inactive', 'baseline-inactive', 'principal-inactive'] as const) {
    const f = semanticFixture(); let principal = semanticPrincipal;
    switch (restriction) {
      case 'closed': f.state.closed = true; break;
      case 'policy': f.state.policy = true; break;
      case 'ended-policy': f.state.policy = true; f.state.policyEnded = true; break;
      case 'unverified': principal = { ...principal, emailVerified: false }; break;
      case 'nonmember': f.state.member = false; break;
      case 'inactive': f.state.collectionActive = false; break;
      case 'noncurator': f.state.curator = semanticId(4); break;
      case 'subject-inactive': f.state.subjectActive = false; break;
      case 'control-inactive': f.state.controlActive = false; break;
      case 'baseline-inactive': f.state.baselineActive = false; break;
      case 'principal-inactive': f.state.principalActive = false; break;
    }
    const result = await f.read(principal);
    expect(result.public.size).toBe(0); expect(result.granted.size).toBe(0);
    expect(f.counts()).toEqual({ connected: 1, released: 1, transaction: false });
  }
});

test('explicit semantic grants retain their own authority without email or member prerequisites', async () => {
  const f = semanticFixture();
  f.state.gate = true; f.state.semanticGrant = true; f.state.member = false;
  f.state.collectionActive = false; f.state.policy = true; f.state.policyEnded = true;
  const result = await f.read({ ...semanticPrincipal, emailVerified: false });
  expect(result.public.size).toBe(0); expect(result.granted).toEqual(new Set([privateCollection]));
  expect(f.sql.some(row => row.query.includes('FROM access.agent_provision'))).toBe(false);
  for (const restriction of ['closed', 'subject', 'representation', 'grant'] as const) {
    const denied = semanticFixture(); denied.state.gate = true; denied.state.semanticGrant = true;
    denied.state.member = false;
    if (restriction === 'closed') denied.state.closed = true;
    if (restriction === 'subject') denied.state.subjectActive = false;
    if (restriction === 'representation') denied.state.representationActive = false;
    if (restriction === 'grant') denied.state.grantActive = false;
    expect((await denied.read({ ...semanticPrincipal, emailVerified: false })).granted.size).toBe(0);
  }
});

test('semantic summaries never borrow independent Work grants or author authority', async () => {
  const f = semanticFixture(); f.state.gate = true; f.state.workGrant = true; f.state.member = false;
  const result = await f.read();
  expect(result.public.size).toBe(0); expect(result.granted.size).toBe(0);
  const statements = f.sql.map(row => `${row.query} ${JSON.stringify(row.values)}`).join('\n');
  expect(statements).not.toContain('work:read:'); expect(statements).not.toContain('work.read');
  expect(statements).not.toContain('work_maintainer');
  expect(f.graphReads.some(query => query.includes('work:create:root') || query.includes('rv:creationAdmission'))).toBe(false);
});

test('semantic batch recovery, missing graph and 65-resource bounds fail before disclosure', async () => {
  const held = semanticFixture(); held.state.recoveryOpen = false;
  await expect(held.read()).rejects.toBeInstanceOf(PolicyUnavailable);
  expect(held.graphReads).toHaveLength(0);
  expect(held.sql.at(-1)?.query).toBe('ROLLBACK');
  expect(held.counts()).toEqual({ connected: 1, released: 1, transaction: false });
  const absent = semanticFixture();
  await expect(readSemanticDisclosure({ pool: absent.pool }, semanticPrincipal, semanticActor, [privateCollection]))
    .rejects.toThrow('public disclosure needs a baseline graph');
  expect(absent.counts().connected).toBe(0);
  const maximum = semanticFixture();
  const refs = Array.from({ length: SEMANTIC_DISCLOSURE_LIMIT }, (_, index) => semanticId(index + 10));
  const accepted = await maximum.read(null, refs);
  expect(accepted.public.size).toBe(0); expect(accepted.granted.size).toBe(0);
  expect(maximum.graphReads).toHaveLength(1);
  expect(maximum.graphReads[0]).toContain('LIMIT 66');
  const exceeded = semanticFixture();
  await expect(exceeded.read(semanticPrincipal, [...refs, privateCollection])).rejects.toBeInstanceOf(RangeError);
  expect(exceeded.counts().connected).toBe(0); expect(exceeded.graphReads).toHaveLength(0);
});
