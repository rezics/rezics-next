import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { referenceReader } from '../src/modules/semantic/admitted.ts';

const DEFINITION = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000d1';
const HIDDEN = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000d2';
const PRINCIPAL = { issuer: 'https://account.test', subject: 'writer' };
const ACTOR = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a1';

/** An Access pool whose only policy answer is that the public candidates are not closed by any gate. */
function accessPool(): Pool {
  const client = { release() {}, query: async (sql: string, params?: unknown[][]) => sql.includes('recovery_fence')
    ? { rows: [{ open: true, generation: '1' }] }
    : sql.includes('unnest') ? { rows: (params?.[0] ?? []).map(resource => ({ resource })) } : { rows: [] } };
  return { connect: async () => client } as unknown as Pool;
}

/** A graph that discloses only the relation definition, as the active relation vocabulary is public. */
const graph = { query: async (sparql: string) => ({ results: { bindings: sparql.includes(DEFINITION)
  ? [{ resource: { type: 'uri', value: DEFINITION } }] : [] } }) };

test('a relation definition is readable to a writer holding no grant on it once composition configures the graph', async () => {
  const access = new AccessAdmissionRegistry(accessPool(), 'key');
  access.configureBaseline(graph);
  const readable = referenceReader(access, PRINCIPAL, ACTOR);
  expect(await readable(DEFINITION)).toBe(true);
  expect(await readable(HIDDEN)).toBe(false);
});

test('missing graph composition fails loudly when a writer checks relation vocabulary', async () => {
  const readable = referenceReader(new AccessAdmissionRegistry(accessPool(), 'key'), PRINCIPAL, ACTOR);
  await expect(readable(DEFINITION)).rejects.toThrow('configureBaseline(fuseki)');
});
