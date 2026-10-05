import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { REFERENCE_DISCLOSURE_COST } from '../src/modules/access/semantic-disclosure.ts';
import {
  CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT,
} from '../src/modules/classification/context.ts';
import {
  resolveStatementAcceptance,
  resolveStatementAcceptancesAt,
  StatementBatchUnavailable,
} from '../src/modules/statement/read.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (number: number) =>
  `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const principal = { issuer: 'https://account.test', subject: 'reader' },
  actor = id(999);
const position = { dataEpoch: 'epoch', sequence: '7' };
const term = (value: string) => ({ type: 'uri', value });

test('reference pages use one public graph batch and a fixed Access batch count at 1, 20 and 40 items', async () => {
  const sqlCounts: number[] = [];
  for (const count of [1, 20, 40]) {
    const refs = Array.from({ length: count }, (_, i) => id(i + 1));
    let graphReads = 0,
      sqlReads = 0;
    const client = {
      release() {},
      query: async (sql: string) => {
        sqlReads++;
        const rows = sql.includes('access.recovery_fence')
          ? [{ open: true, generation: '0' }]
          : sql.startsWith('SELECT id FROM access.principal')
            ? [{ id: '00000000-0000-4000-8000-000000000001' }]
            : sql.includes('CROSS JOIN (VALUES')
              ? refs.map((resource) => ({ resource }))
              : [];
        return { rows, rowCount: rows.length };
      },
    };
    const registry = new AccessAdmissionRegistry({
      connect: async () => client,
    } as unknown as Pool);
    registry.configureBaseline({
      query: async (query) => {
        graphReads++;
        expect(query).toContain('VALUES ?resource');
        for (const ref of refs) expect(query).toContain(ref);
        return { results: { bindings: [] } };
      },
    });
    expect(await registry.canReadReferences(principal, actor, refs)).toEqual(new Set(refs));
    expect(graphReads).toBe(1);
    expect(graphReads).toBeLessThanOrEqual(REFERENCE_DISCLOSURE_COST.graphReads);
    sqlCounts.push(sqlReads);
  }
  expect(new Set(sqlCounts).size).toBe(1);
});

test('reference batches fail before disclosure on missing graph, held recovery or oversized input', async () => {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error('database must not be reached');
      },
    },
  ) as Pool;
  const registry = new AccessAdmissionRegistry(unreachable);
  expect(await registry.canReadReferences(null, null, [])).toEqual(new Set());
  expect(await registry.canReadReferences(principal, actor, ['not-a-resource'])).toEqual(new Set());
  await expect(registry.canReadReferences(principal, actor, [id(1)])).rejects.toThrow(
    'configureBaseline',
  );
  await expect(registry.canReadReferences(principal, actor, Array(66).fill(id(1)))).rejects.toThrow(
    'batch exceeds',
  );
  let graphReads = 0,
    released = false;
  const client = {
    release() {
      released = true;
    },
    query: async (sql: string) => ({
      rows: sql.includes('access.recovery_fence') ? [{ open: false, generation: '0' }] : [],
    }),
  };
  const held = new AccessAdmissionRegistry({ connect: async () => client } as unknown as Pool);
  held.configureBaseline({
    query: async () => {
      graphReads++;
      return { results: { bindings: [] } };
    },
  });
  await expect(held.canReadReferences(principal, actor, [id(1)])).rejects.toThrow(
    'recovery is held',
  );
  expect(graphReads).toBe(0);
  expect(released).toBe(true);
});

function acceptanceFixture(
  count: number,
  options: {
    policy?: string;
    global?: boolean;
    moved?: boolean;
    partial?: boolean;
    duplicate?: boolean;
    held?: boolean;
  } = {},
) {
  const ids = Array.from({ length: count }, (_, i) => id(i + 1));
  const policy = options.policy ?? CLASSIFICATION_INHERIT_POLICY;
  const context = options.global ? GLOBAL_CLASSIFICATION_CONTEXT : id(800);
  const scope = {
    epoch: term(position.dataEpoch),
    sequence: term(options.moved ? '8' : position.sequence),
    context: term(context),
    policy: term(policy),
  };
  const rows: NonNullable<SparqlResult['results']>['bindings'] = ids.map((statement, i) => ({
    epoch: term(position.dataEpoch),
    sequence: term(position.sequence),
    statement: term(statement),
    ...(!options.global && i % 5 !== 0
      ? {
          localSlot: term(id(1000 + i)),
          ...(i % 5 === 4
            ? {}
            : {
                localDecision: term(id(2000 + i)),
                localOutcome: term(
                  `https://rezics.com/vocab/${['Accepted', 'Accepted', 'Rejected', 'Withdrawn'][i % 5]}`,
                ),
              }),
        }
      : {}),
    ...(i % 10 === 0
      ? {}
      : {
          globalSlot: term(id(3000 + i)),
          globalDecision: term(id(4000 + i)),
          globalOutcome: term('https://rezics.com/vocab/Accepted'),
        }),
  }));
  const queries: string[] = [];
  const graph = {
    query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      if (query.includes('ASK {')) return { boolean: !options.held };
      if (query.includes('VALUES (?statement ?wantedGlobalSlot')) {
        return {
          results: {
            bindings: options.partial
              ? rows.slice(1)
              : options.duplicate
                ? [...rows, rows[0]!]
                : rows,
          },
        };
      }
      const statement = ids.find((ref) => query.includes(`<${ref}>`));
      const target = rows.find((row) => row.statement!.value === statement);
      return {
        results: {
          bindings: query.includes('?context ?policy')
            ? [{ ...scope, ...(options.global ? target : {}) }]
            : target
              ? [target]
              : [],
        },
      };
    },
  };
  const env = {
    fuseki: graph as FusekiClient,
    lineage: { dataEpoch: position.dataEpoch, routingEpoch: 'routing' },
    objectDirectory: '.temp',
  } as WorkActivationEnvironment;
  const acceptance = options.global
    ? { kind: 'global' as const }
    : { kind: 'realm' as const, realm: id(900) };
  return { ids, rows, queries, env, acceptance };
}

test('Statement acceptance pages preserve scalar absent, inherited, accepted, rejected, withdrawn and unavailable decisions', async () => {
  for (const options of [{}, { policy: CLASSIFICATION_ISOLATE_POLICY }, { global: true }]) {
    const f = acceptanceFixture(20, options);
    const batch = await resolveStatementAcceptancesAt(f.env, f.ids, f.acceptance, position);
    expect(f.queries).toHaveLength(3);
    for (const statement of f.ids) {
      expect(batch.get(statement)).toEqual(
        await resolveStatementAcceptance(f.env, { kind: 'statement', statement }, f.acceptance),
      );
    }
  }
});

test('Statement acceptance costs three graph reads for both one target and a full page', async () => {
  for (const size of [1, 20]) {
    const f = acceptanceFixture(size);
    expect((await resolveStatementAcceptancesAt(f.env, f.ids, f.acceptance, position)).size).toBe(
      size,
    );
    expect(f.queries).toHaveLength(3);
    expect(f.queries[2]).toContain('rv:statementState rv:Active');
    expect(f.queries[2]).toContain('?localOutcome = rv:Withdrawn');
  }
});

test('Statement acceptance pages reject moved scope, incomplete or duplicate slots and held recovery without partial results', async () => {
  for (const options of [{ moved: true }, { partial: true }, { duplicate: true }, { held: true }]) {
    const f = acceptanceFixture(2, options);
    const read = resolveStatementAcceptancesAt(f.env, f.ids, f.acceptance, position);
    if (options.moved) await expect(read).rejects.toBeInstanceOf(SearchSnapshotMoved);
    else if (options.held) await expect(read).rejects.toThrow('graph admission is held');
    else await expect(read).rejects.toBeInstanceOf(StatementBatchUnavailable);
  }
});
