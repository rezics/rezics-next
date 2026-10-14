import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { readRealmZone } from '../src/modules/realm-reads/read-zone.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const native = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const realm = native(1), space = native(2), revision = native(3);
const first = native(10), second = native(11);
const term = (value: string) => ({ type: 'uri', value });
const candidate = (zone: string, official = false) => ({ zone: term(zone), zoneSpace: term(space),
  ...(official ? { official: term('true') } : {}) });
const publication = (zone: string, patch: object = {}) => ({ zone, realm, space, revision,
  official: null, disclosure: 'public', storedDisclosure: 'public', listing: 'listed', discovery: 'listed',
  presentation: DEFAULT_ZONE_PRESENTATION, ...patch });

class RealmDisclosure extends DisclosureStore {
  closed = false;
  constructor() { super({} as Pool); }
  override async read() { return [this.closed ? 'hidden' as const : 'visible' as const]; }
}

function owner(rows = [candidate(first), candidate(second)], signedIn = true) {
  const disclosure = new RealmDisclosure();
  const queries: { body: string; limit: number }[] = [];
  const visibility: string[] = [];
  let access = new Set([first, second]);
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (body: string) => {
      if (body.includes('ASK')) return { boolean: true };
      const zone = [first, second].find(id => body.includes(`<${id}>`))!;
      visibility.push(zone);
      return { results: { bindings: [{ kind: term('space'), space: term(space),
        disclosure: term(`${RV}Private`), zoneDisclosure: term(`${RV}Private`) }] } };
    } },
  } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, () => undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async () => disclosure.read()));
  const session = { options: signedIn ? { actingSubject: native(20) } : {},
    principal: signedIn ? {} : null, viewer: ANONYMOUS_VIEWER,
    position: { dataEpoch: 'epoch', sequence: '8' },
    deps: { environment, access: { canReadSemanticResource: async (_principal: unknown, _actor: string, zone: string) => access.has(zone) } },
    realm: async () => ({ space, realmRevision: revision, visibility: 'public', reviewMode: 'open', revision: null }),
    observeDependency: () => '',
    query: async (body: string, limit: number) => { queries.push({ body, limit }); return rows; },
  } as unknown as WorkReadSession;
  return { session, queries, visibility, disclosure, revoke: () => { access = new Set(); } };
}

test('owner selects the first published ordinary Zone from legal multiple attachments', async () => {
  const fixture = owner();
  const read = async (_env: WorkActivationEnvironment, zone: string) => publication(zone) as never;
  expect(await readRealmZone(fixture.session, realm, read)).toMatchObject({
    zone: first, realm, revision, presentation: DEFAULT_ZONE_PRESENTATION,
    sourcePosition: fixture.session.position });
});
