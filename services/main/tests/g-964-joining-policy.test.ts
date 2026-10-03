import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessRealmJoining } from '../src/modules/access/realm-management-joining.ts';
import { RealmAdminDenied } from '../src/modules/realm-admin/contract.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RV } from '../src/modules/work/activate.ts';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
test('G-964: joining basis separates private visibility from open admission and withholds closed private policies from outsiders', async () => {
  for (const visibility of ['public', 'private'] as const) for (const admission of ['open', 'request', 'invitation'])
    for (const policyOpen of [false, true]) {
      let locked = false;
      const client = { release() {}, query: async (sql: string) => {
        if (sql.includes('SELECT 1 FROM access.scope_gate')) locked = true;
        if (sql.includes('p.enforcement_epoch')) return { rows: [{ id: 'principal' }] };
        if (sql.includes('p.revision::text')) return { rows: [{ revision: '3', terms_revision: 'terms',
          open: policyOpen, self_join: admission === 'open', visibility }] };
        if (sql.includes('SELECT id,generation') || sql.includes('realm_invitation') || sql.includes('realm_policy_delivery')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      } };
      const pool = { connect: async () => client } as unknown as Pool;
      const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: { query: async () => {
        expect(locked).toBe(true);
        const binding = (value: string) => ({ type: 'literal', value });
        return { results: { bindings: [{ space: binding(id), disclosure: binding(RV + (visibility === 'public' ? 'Public' : 'Private')),
          admission: binding(admission) }] } };
      } } } as unknown as WorkActivationEnvironment;
      const reading = new AccessRealmJoining(pool, env).policyFor({ issuer: 'test', subject: 'reader' }, id, id);
      if (visibility === 'private' && !(admission === 'open' && policyOpen)) {
        await expect(reading).rejects.toBeInstanceOf(RealmAdminDenied);
      } else expect(await reading).toMatchObject({ open: policyOpen, selfJoin: admission === 'open' && policyOpen });
    }
});
