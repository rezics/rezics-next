import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { resolveCommandTarget, TargetNotBound, TargetUnavailable, type TargetReadSession } from '../src/modules/target/resolve.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { SuitabilityStore } from '../src/modules/suitability/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const position = { dataEpoch: 'epoch', sequence: '1' };
const row = (base: string, work: string | null = id(1)) => ({ epoch: term(position.dataEpoch),
  sequence: term(position.sequence), r: term(id(1)), base: term(base), revision: term(id(11)),
  ...(work ? { work: term(work) } : {}), type: term('https://schema.org/CreativeWork') });

test('G-897: command proofs preserve each native grain and hydrate only bounded identity metadata', async () => {
  for (const base of ['work', 'realization', 'release', 'occurrence', 'resource']) {
    const work = base === 'resource' ? null : id(1);
    const session = { checkDeadline() {}, position, query: async (query: string, limit: number) => {
      expect(limit).toBe(64);
      expect(query).toContain('LIMIT 65');
      expect(query).toContain('rv:ErasedRevision');
      expect(query).not.toContain('rdfs:label');
      expect(query).not.toContain('rv:publicTitle');
      expect(query).not.toContain('rv:contentRevision');
      return [row(base, work)];
    } } as unknown as TargetReadSession;
    expect(await resolveCommandTarget(session, id(1))).toMatchObject({ resource: id(1), base,
      work, revision: id(11), disclosure: 'restricted' });
  }
});

test('G-897: command proofs reject absent, unbound, ambiguous and moving targets', async () => {
  const session = (rows: object[]) => ({ checkDeadline() {}, position,
    query: async () => rows }) as unknown as TargetReadSession;
  await expect(resolveCommandTarget(session([{ epoch: term('epoch'), sequence: term('1') }]), id(1)))
    .rejects.toBeInstanceOf(TargetUnavailable);
  await expect(resolveCommandTarget(session([row('main-version')]), id(1)))
    .rejects.toBeInstanceOf(TargetNotBound);
  for (const rows of [[row('work'), row('release')], [row('work'), { ...row('work'), work: term(id(2)) }],
    [row('work'), { ...row('work'), revision: term(id(12)) }]]) {
    await expect(resolveCommandTarget(session(rows), id(1))).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  await expect(resolveCommandTarget(session([{ ...row('work'), sequence: term('2') }]), id(1)))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('G-897: platform command authority is established before even probing a rated target identity', async () => {
  let graphProbes = 0;
  const pool = { connect: async () => ({ release() {}, query: async (sql: string) => {
    if (sql.includes('access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('FROM access.principal')) return { rows: [{ id: 'principal', enforcement_epoch: '1' }] };
    if (sql.includes('FROM access.scope_gate')) return { rows: [{ open: false, dispatch_open: false }] };
    return { rows: [] };
  } }) } as unknown as Pool;
  const store = new SuitabilityStore(pool, { withWorkEditAuthority: async () => {
    throw new Error('Platform commands cannot fall back to Work edit authority');
  } });
  const environment = { fuseki: { query: async () => { graphProbes++; throw new Error('Identity probe ran without authority'); } } } as unknown as WorkActivationEnvironment;
  await expect(store.writeCommand({ issuer: 'account', subject: 'reader' }, id(1), {
    actingSubject: id(9), expectedRevision: id(11), labels: [], basis: 'platform',
  }, 'g897-denied-correction', environment)).rejects.toThrow('scope is closed');
  expect(graphProbes).toBe(0);
});
