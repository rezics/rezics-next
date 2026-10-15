import { expect, test } from 'bun:test';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { RV } from '../src/modules/work/activate.ts';

test('shared hydration retains isolated values but still closes the live owner dependency', async () => {
  const session = new WorkReadSession({} as MainWorkDependencies, new Request('http://main.test/v1/read'),
    {}, { dataEpoch: 'epoch', sequence: '1' });
  let current = { revision: 'first', entries: ['original'] }, reads = 0;
  const owner = async () => { reads++; return structuredClone(current); };
  const hydrate = async () => {
    const value = await owner();
    session.observeDependency('selected-owner', value, owner);
    return value;
  };
  const [first, second] = await Promise.all([
    session.retained('selected-owner', hydrate), session.retained('selected-owner', hydrate),
  ]);
  first.entries.push('caller mutation');
  expect(second.entries).toEqual(['original']);
  expect(reads).toBe(1);
  await session.fenceDependencies();
  expect(reads).toBe(2);
  current = { revision: 'successor', entries: ['original'] };
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('Realm policy hydration is shared within a request and a policy change fails its closing fence', async () => {
  let reads = 0, revision = 'first';
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: {
    query: async () => {
      reads++;
      const term = (value: string) => ({ type: 'literal', value });
      return { results: { bindings: [{ space: term('space'), realmRevision: term(revision),
        disclosure: term(`${RV}Public`), visibility: term('public'), mode: term('open') }] } };
    },
  } } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/realms/read'),
    {}, { dataEpoch: 'epoch', sequence: '1' });
  await session.realm('urn:rezics:realm'); await session.realm('urn:rezics:realm');
  expect(reads).toBe(1);
  revision = 'successor';
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});
