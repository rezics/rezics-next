import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneModuleRoutes } from '../src/routes/zone-modules.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const native = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const realm = native(1), space = native(2), revision = native(3), absent = native(4), actor = native(5);
const modules = ['new-adoptions', 'recently-completed', 'recent-decisions', 'latest-chapters',
  'discussions', 'reader-quotes', 'editor-lists', 'browse', `genres/${native(6).slice(-36)}`];

function fixture(privateRealm = false) {
  let verifications = 0;
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: {
    query: async (query: string) => {
      if (query.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{
        epoch: { value: 'epoch' }, sequence: { value: '1' } }] } };
      if (query.includes('SELECT ?space ?realmRevision')) return { results: { bindings:
        query.includes(`<${absent}>`) ? [] : [{ space: { value: space }, realmRevision: { value: revision },
          visibility: { value: privateRealm ? 'private' : 'public' }, mode: { value: 'open' },
          disclosure: { value: `${RV}${privateRealm ? 'Private' : 'Public'}` } }] } };
      throw new Error('Concealed modules must refuse before source hydration');
    },
  } } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, () => undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(() => 'hidden')));
  const dependencies = { environment,
    account: { verify: async () => { verifications++; return { issuer: 'account', subject: 'reader' }; } },
    access: { assertRecoveryOpen: async () => undefined,
      realmReadProof: async () => { throw new Error('Public modules cannot borrow member authority'); } },
  } as unknown as MainWorkDependencies;
  return { app: zoneModuleRoutes(dependencies), verifications: () => verifications };
}

for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator']) {
  test(`closed Realm module routes deliver ordinary absence for ${persona}`, async () => {
    const owner = fixture();
    for (const module of modules) {
      const request = (target: string) => new Request(`http://main.test/v1/realms/${target.slice(-36)}/modules/${module}`
        + (persona === 'visitor' ? '' : `?actingSubject=${encodeURIComponent(actor)}`),
      { headers: persona === 'visitor' ? {} : { authorization: `Bearer ${persona}` } });
      const hidden = await owner.app.handle(request(realm));
      const missing = await owner.app.handle(request(absent));
      expect(hidden.status, module).toBe(404);
      expect(missing.status, module).toBe(404);
      expect(await hidden.json(), module).toEqual(await missing.json());
    }
    expect(owner.verifications()).toBe(persona === 'visitor' ? 0 : modules.length * 2);
  });
}

test('an acting subject and bearer cannot widen a private Realm module publication', async () => {
  const owner = fixture(true);
  for (const module of modules) {
    const response = await owner.app.handle(new Request(
      `http://main.test/v1/realms/${realm.slice(-36)}/modules/${module}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer realm-owner' } },
    ));
    expect(response.status, module).toBe(404);
  }
  expect(owner.verifications()).toBe(modules.length);
});
