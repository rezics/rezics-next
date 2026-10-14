import { expect, test } from 'bun:test';
import { classificationRoutes } from '../src/routes/classification.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure, type DisclosureDecision } from '../src/modules/disclosure/read.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const native = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const realm = native(1), absent = native(2), context = native(3), revision = native(4), scheme = native(5);
const uri = (value: string) => ({ type: 'uri', value });

function fixture(options: { closed?: boolean; closeDuringHydration?: boolean; missingDisclosure?: boolean } = {}) {
  let closed = options.closed ?? false, hydrated = 0;
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: {
    query: async (query: string) => {
      if (query.includes('ASK')) return { boolean: true };
      if (query.includes('SELECT ?context ?revision ?scheme')) {
        hydrated++;
        if (options.closeDuringHydration) closed = true;
        return { results: { bindings: query.includes(`<${absent}>`) ? []
          : [{ context: uri(context), revision: uri(revision), scheme: uri(scheme) }] } };
      }
      if (query.includes('SELECT ?space ?realmRevision')) return { results: { bindings: [{
        space: uri(native(6)), realmRevision: uri(native(7)), disclosure: uri(`${RV}Public`),
      }] } };
      throw new Error(`Unexpected classification Context query: ${query}`);
    },
  } } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, () => undefined);
  if (!options.missingDisclosure) configureDisclosure(environment, fixtureDisclosureReader(async targets => {
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ owner: 'graph', component: 'record' });
    return targets.map(target => (closed || target.resource === absent ? 'hidden' : 'visible') as DisclosureDecision);
  }));
  const dependencies = { environment } as MainWorkDependencies;
  return { app: classificationRoutes(environment.fuseki, dependencies), hydrated: () => hydrated };
}

async function read(app: ReturnType<typeof classificationRoutes>, target = realm, bearer?: string) {
  const response = await app.handle(new Request(`http://main.test/v1/realms/${target.slice(-36)}/classification-context`,
    { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
  return { status: response.status, body: await response.json() as unknown };
}

test('public classification Context returns its selected scheme while its Realm is disclosed', async () => {
  const owner = fixture();
  expect(await read(owner.app)).toMatchObject({ status: 200, body: { realm, context,
    contextRevision: revision, scheme } });
  expect(owner.hydrated()).toBe(1);
});

test('closed classification Context answers exactly as absent for every public caller', async () => {
  for (const bearer of [undefined, 'stranger', 'member', 'owner', 'moderator', 'operator']) {
    const owner = fixture({ closed: true });
    const hidden = await read(owner.app, realm, bearer);
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(await read(owner.app, absent, bearer));
    expect(owner.hydrated()).toBe(0);
  }
});

test('Realm closure during Context hydration withholds the selected scheme', async () => {
  const owner = fixture({ closeDuringHydration: true });
  const hidden = await read(owner.app);
  expect(hidden.status).toBe(404);
  expect(hidden).toEqual(await read(owner.app, absent));
  expect(owner.hydrated()).toBe(1);
});

test('a missing disclosure owner refuses classification Context metadata', async () => {
  const owner = fixture({ missingDisclosure: true });
  expect((await read(owner.app)).status).toBe(503);
  expect(owner.hydrated()).toBe(0);
});
