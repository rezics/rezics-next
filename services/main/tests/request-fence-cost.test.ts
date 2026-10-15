import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { authorityWitnessCurrent, captureAuthorityWitness, type AuthorityWitness } from '../src/modules/access/authority-witness.ts';
import { ProfilesAccess } from '../src/modules/profiles/access.ts';
import { workRead, WorkReadMoved, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { noteGraphReadVersion } from '../src/infrastructure/graph-read-fence.ts';

const principal = '00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const representation = '00000000-0000-4000-8000-000000000003';
const proof = { policy_generation: '1', provision_id: 'provision', representation_id: representation,
  representation_generation: '1', subject_generation: '1', principal_epoch: '1',
  collection_create: false, related_work: null, source_revision: null, maintainer_generation: null };

function commandFixture() {
  const statements: string[] = [];
  const witnessRows = [
    { source_table: 'principal', source_row: { id: principal, generation: '1' } },
    { source_table: 'authority_subject', source_row: { id: actor, generation: '1' } },
    { source_table: 'representation', source_row: { id: representation, generation: '1', subject_id: actor,
      valid_until: '2099-01-01T00:00:00Z' } },
  ];
  const client = { release() {}, query: async (sql: string, args?: unknown[]) => {
    statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes('AS source_table')) rows = witnessRows;
    else if (sql.includes('SELECT *,') && sql.includes('FOR SHARE')) {
      rows = witnessRows.filter(row => sql.includes(`FROM access.${row.source_table} `) && row.source_row.id === args?.[0])
        .map(row => row.source_row);
    } else if (sql.includes('FROM access.agent_provision a')) rows = [proof];
    else if (sql.includes('f.generation AS recovery')) rows = [{ id: actor, generation: '1', recovery: '1', open: true }];
    else if (sql.includes('FROM access.recovery_fence')) rows = [{ open: true, generation: '1' }];
    else if (sql.includes('SELECT authority_epoch')) rows = [{ authority_epoch: '1', group_generation: '1', open: true, dispatch_open: true }];
    else if (sql.includes('FROM access.principal') && sql.includes('account_issuer')) rows = [{ id: principal, active: true, enforcement_epoch: '1' }];
    else if (sql.includes('SELECT active, kind')) rows = [{ active: true, kind: 'agent' }];
    else if (sql.includes('INSERT INTO access.admission\n')) rows = [{ registered_at: new Date(), expires_at: new Date('2099-01-01') }];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  return { statements, witnessRows, client, pool: { connect: async () => client } as unknown as Pool };
}

test('baseline Work creation and its Agent fence have a fixed statement budget', async () => {
  const f = commandFixture();
  const admitted = await new AccessAdmissionRegistry(f.pool).register({
    principal: { issuer: 'account', subject: 'writer', emailVerified: true }, actingSubject: actor,
    action: 'work.create', scope: 'work:create:root', idempotencyKey: 'create', requestDigest: 'a'.repeat(64),
  });
  expect(admitted.dispatchEligible).toBe(true);
  const registrationStatements = f.statements.length;
  expect(await new ProfilesAccess(f.pool).agentFence(actor)).toBe('1:1');
  expect([registrationStatements, f.statements.length]).toEqual([21, 26]);
});

test('baseline authority captures and checks all exact sources in one statement each', async () => {
  const f = commandFixture();
  const witness = await captureAuthorityWitness(f.client, f.witnessRows.map(row => ({
    table: row.source_table as AuthorityWitness['table'], id: row.source_row.id, generation: '1',
  })));
  expect(witness).toHaveLength(3);
  expect(witness.find(row => row.table === 'representation')?.validUntil).toBe('2099-01-01T00:00:00.000Z');
  expect(f.statements).toHaveLength(1);
  expect(await authorityWitnessCurrent(f.client, witness)).toBe(true);
  expect(f.statements).toHaveLength(2);
  f.witnessRows[1]!.source_row.generation = '2';
  expect(await authorityWitnessCurrent(f.client, witness)).toBe(false);
  await expect(captureAuthorityWitness(f.client, witness)).rejects.toBeInstanceOf(AdmissionDenied);
  expect(f.statements.every(sql => sql.match(/FOR SHARE/g)?.length === 3)).toBe(true);
});

function readFixture() {
  const state = { sequence: 1, physicalVersion: 1, hasVersion: true, epoch: 'epoch', head: 'head', owner: 'visible', graphReads: 0, versions: 0,
    authorityChecks: 0, ownerReads: 0, onVersion: () => {} };
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: {
    query: async (sql: string) => {
      if (sql.includes('SELECT ?epoch ?sequence')) {
        state.versions++; state.onVersion();
        const result = { results: { bindings: [{ epoch: { type: 'literal', value: state.epoch },
          sequence: { type: 'literal', value: String(state.sequence) } }] } };
        if (state.hasVersion) noteGraphReadVersion(result, `store:${state.physicalVersion}`);
        return result;
      }
      state.graphReads++;
      return { results: { bindings: [{ head: { type: 'literal', value: state.head } }] } };
    },
  } }, access: { assertRecoveryOpen: async () => { state.authorityChecks++; } } } as unknown as MainWorkDependencies;
  // An internal read has no retry: each refusal is directly observable.
  const request = new Request('http://main.test/internal/read');
  const read = (change = () => {}) => workRead(deps, request, {}, async session => {
    const page = await session.selection('representative-page', async probe => {
      const rows: ReadRow[][] = [];
      for (let part = 0; part < 8; part++) rows.push(await probe.query(`SELECT ?head WHERE { # part ${part}\n }`, 1));
      state.ownerReads++;
      return { rows, owner: state.owner };
    });
    change();
    return page;
  });
  return { state, read };
}

test('a fenced page reads its eight graph inputs once, using three constant-size version probes', async () => {
  const f = readFixture();
  expect((await f.read()).rows).toHaveLength(8);
  expect(f.state.graphReads).toBe(8);
  expect(f.state.versions).toBe(3);
  expect(f.state.ownerReads).toBe(2);
  expect(f.state.authorityChecks).toBe(3);
});

test('a moved graph replays selected inputs and refuses changed results', async () => {
  const f = readFixture();
  await expect(f.read(() => { f.state.physicalVersion++; f.state.head = 'changed'; })).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.state.graphReads).toBe(16);
});

test('an unchanged graph never caches an owner authority decision', async () => {
  const f = readFixture();
  await expect(f.read(() => { f.state.owner = 'withheld'; })).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.state.graphReads).toBe(8);
});

test('the closing version refuses graph movement during a live owner check', async () => {
  const f = readFixture();
  f.state.onVersion = () => { if (f.state.versions === 3) { f.state.physicalVersion++; f.state.head = 'changed'; } };
  await expect(f.read()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('an unrelated write during the closing version falls back without requiring a quiet dataset', async () => {
  const f = readFixture();
  f.state.onVersion = () => { if (f.state.versions === 3) f.state.physicalVersion++; };
  expect((await f.read()).rows).toHaveLength(8);
  expect(f.state.graphReads).toBe(16);
});

test('an epoch replacement still refuses a read before replay', async () => {
  const f = readFixture();
  await expect(f.read(() => { f.state.epoch = 'restored'; })).rejects.toThrow('Graph is unavailable');
});

test('a missing physical version retains the complete selected-input fence', async () => {
  const f = readFixture(); f.state.hasVersion = false;
  await expect(f.read(() => { f.state.head = 'changed'; })).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.state.graphReads).toBe(16);
  expect(f.state.versions).toBe(2);
});
