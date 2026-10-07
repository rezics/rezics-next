import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { identityKeyUuid, uuidToSid } from '@rezics/model/address/sid';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { addressRoutes } from '../src/routes/addresses.ts';
import { ALIAS_COST, type AliasRow } from '../src/modules/address/registry.ts';
import { resolveAddresses } from '../src/modules/address/resolution.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';

const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const uri = (value: string) => ({ type: 'uri', value });
const text = (value: string) => ({ type: 'literal', value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']) => ({
  results: { bindings },
});

function fixture() {
  const queries: string[] = [];
  const state = {
    recoveryOpen: true as boolean | undefined,
    admission: 'request',
    policyReads: 0,
    revokeAt: Infinity,
    named: true,
    fail: false,
    semanticOnly: false,
  };
  const current = {
    scope: 'space',
    holder: space,
    key: 'private-books',
    state: 'current',
    revision: '00000000-0000-4000-8000-000000000005',
  } as AliasRow;
  const references = (query: string) =>
    [...(query.match(/VALUES \?resource \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(
      (match) => match[1]!,
    );
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        if (state.fail) throw new Error('graph unavailable');
        if (query.includes('ASK')) return { boolean: true };
        if (query.includes('SELECT ?epoch ?sequence WHERE'))
          return rows([{ epoch: text('epoch'), sequence: text('7') }]);
        if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
          const wanted = query.match(/VALUES \?r \{([^}]*)\}/)?.[1] ?? '';
          const found = [space, realm, zone]
            .filter((ref) => wanted.includes(`<${ref}>`))
            .map((ref) => ({
              epoch: text('epoch'),
              sequence: text('7'),
              r: uri(ref),
              public: text('false'),
              type: text(ref === space ? 'space' : ref === realm ? 'realm' : 'zone'),
              label: { ...text('Private books'), 'xml:lang': 'en' },
            }));
          return rows(found.length ? found : [{ epoch: text('epoch'), sequence: text('7') }]);
        }
        if (query.includes('SELECT DISTINCT ?resource ?space ?disclosure'))
          return rows(
            references(query).map((ref) => ({
              resource: uri(ref),
              space: uri(space),
              disclosure: uri(RV + 'Private'),
              realm: uri(realm),
              ...(ref === zone ? { zoneDisclosure: uri(RV + 'Private') } : {}),
            })),
          );
        if (query.includes('SELECT DISTINCT ?resource ?space ?realm ?zone'))
          return rows(
            references(query)
              .filter((ref) => [space, realm, zone].includes(ref))
              .map((ref) => ({
                resource: uri(ref),
                space: uri(space),
                realm: uri(realm),
                zone: uri(zone),
              })),
          );
        if (query.includes('SELECT ?space ?realmRevision ?disclosure')) {
          state.policyReads++;
          return rows([
            {
              space: uri(space),
              realmRevision: uri(actor),
              disclosure: uri(RV + 'Private'),
              visibility: text('private'),
              mode: text('mandatory'),
              head: uri(actor),
              listing: text('listed'),
              admission: text(state.policyReads >= state.revokeAt ? 'invitation' : state.admission),
            },
          ]);
        }
        if (query.includes('SELECT ?revision ?payload ?model')) return rows([{}]);
        if (query.includes('SELECT ?realm ?name WHERE')) return rows([]);
        if (query.includes('SELECT ?name WHERE'))
          return rows([{ name: { ...text('Private books'), 'xml:lang': 'en' } }]);
        throw new Error(`Unexpected query: ${query}`);
      },
    },
    addresses: {
      withRead: async <T>(operation: () => Promise<T>) => operation(),
      identify: async (_scope: string, key: string) => {
        const id = identityKeyUuid(key);
        return {
          holder:
            key === 'private-books'
              ? space
              : ([space, realm, zone].find((ref) => ref.slice(-36) === id) ?? null),
          alias: key === 'private-books' ? current : null,
        };
      },
      heads: async () => new Map(state.named ? [[`space\0${space}`, current]] : []),
      currents: async () => new Map(state.named ? [[`space\0${space}`, current]] : []),
    },
  } as unknown as WorkActivationEnvironment;
  const work = {
    environment: env,
    account: {
      verify: async (_request: Request, scopes: readonly string[]) => {
        if (state.semanticOnly && scopes.includes('work:read'))
          throw new AccountAssertionDenied('Work scope is not issued');
        return { issuer: 'account', subject: 'reader' };
      },
    },
    access: { assertRecoveryOpen: async (): Promise<void> => {
      if (state.recoveryOpen !== true) throw new AdmissionUnavailable('Access is held for recovery');
    },
      canReadSemanticResource: async () => false, canReadWork: async () => false },
  } as unknown as MainWorkDependencies;
  return { work, env, state, current, queries, app: new Elysia().use(addressRoutes(work)) };
}

test('closed or missing Access recovery refuses the address read without landing data', async () => {
  const f = fixture();
  for (const open of [false, undefined]) {
    f.state.recoveryOpen = open;
    const response = await f.app.handle(
      new Request('http://main.local/v1/addresses/resolve?scope=space&key=private-books'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: 'https://rezics.com/problems/alias_unavailable',
      title: 'Space request address is unavailable',
      status: 503,
      code: 'alias_unavailable',
    });
  }
});

test('G982: signed-in legacy UUID resolutions require the selected Agent, not a different key grammar', async () => {
  const f = fixture();
  const path = `http://main.local/v1/addresses/resolve?scope=space&key=${space.slice(-36)}`;
  const headers = { authorization: 'Bearer reader' };
  expect((await f.app.handle(new Request(path, { headers }))).status).toBe(400);
  const resolved = await f.app.handle(
    new Request(`${path}&actingSubject=${encodeURIComponent(actor)}`, { headers }),
  );
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toMatchObject({
    holder: space,
    canonical: { key: 'private-books' },
  });
});

test('G982: a semantic-only reader can resolve the same request landing as an anonymous reader', async () => {
  const f = fixture();
  f.state.semanticOnly = true;
  const response = await f.app.handle(
    new Request(
      `http://main.local/v1/addresses/resolve?${new URLSearchParams({
        scope: 'space',
        key: 'private-books',
        actingSubject: actor,
      })}`,
      { headers: { authorization: 'Bearer semantic-reader' } },
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    canonical: { prefix: '/r/', key: 'private-books' },
    capabilities: { realm },
  });
});

test.each([
  'private-books',
  space.slice(-36),
  uuidToSid(space.slice(-36)),
  `${uuidToSid(space.slice(-36))}-old-title`,
  realm.slice(-36),
])(
  'G982: request admission resolves %s to the public landing without disclosing the private site',
  async (key) => {
    const f = fixture();
    const response = await f.app.handle(
      new Request(
        `http://main.local/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key })}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: 'address-resolution-v1',
      status: 'resolved',
      holder: space,
      canonical: { prefix: '/r/', key: 'private-books', suffixSource: '' },
      capabilities: { realm },
    });
    expect(f.queries.length).toBeLessThanOrEqual(ALIAS_COST.fusekiRequests.resolve);
    const summaries = await readResourceSummaries(
      f.env,
      undefined,
      {},
      {
        resources: [space, realm, zone],
        context: DEFAULT_MEDIA_CONTEXT,
        language: null,
      },
    );
    expect(summaries.summaries).toEqual(
      [space, realm, zone].map((reference) => ({ reference, status: 'unavailable' })),
    );
  },
);

test('G982: an unnamed request Space has an identity canonical address with no private slug', async () => {
  const f = fixture();
  f.state.named = false;
  const result = await resolveAddresses(
    f.work,
    new Request('http://main.local/v1/addresses/resolve'),
    [{ scope: 'space', key: space.slice(-36) }],
  );
  expect(result[0]).toMatchObject({
    canonical: { prefix: '/r/', key: uuidToSid(space.slice(-36)), suffixSource: '' },
  });
});

test('G982: invitation-only, missing and private Zone aliases keep the same unavailable result', async () => {
  const f = fixture();
  f.state.admission = 'invitation';
  for (const key of ['private-books', space.slice(-36), zone.slice(-36), 'absent-books']) {
    const response = await f.app.handle(
      new Request(`http://main.local/v1/addresses/resolve?scope=space&key=${key}`),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'address_not_found' });
  }
  f.state.admission = 'request';
  expect(
    (
      await f.app.handle(
        new Request(`http://main.local/v1/addresses/resolve?scope=space&key=${zone.slice(-36)}`),
      )
    ).status,
  ).toBe(404);
});

test('G982: revoking request admission during landing hydration closes the address', async () => {
  const f = fixture();
  f.state.revokeAt = 3;
  const response = await f.app.handle(
    new Request('http://main.local/v1/addresses/resolve?scope=space&key=private-books'),
  );
  expect(response.status).toBe(404);
});

test('G982: duplicate landing inputs share the read; retirement remains 410', async () => {
  const f = fixture();
  const lookups = Array.from({ length: ALIAS_COST.batch }, () => ({
    scope: 'space' as const,
    key: 'private-books',
  }));
  const result = await resolveAddresses(
    f.work,
    new Request('http://main.local/v1/addresses/resolve'),
    lookups,
  );
  expect(result).toHaveLength(ALIAS_COST.batch);
  expect(result.every((item) => item.status === 'resolved')).toBe(true);
  expect(f.queries.filter((query) => query.includes('SELECT ?name WHERE'))).toHaveLength(1);
  f.current.state = 'retired';
  expect(
    (
      await f.app.handle(
        new Request('http://main.local/v1/addresses/resolve?scope=space&key=private-books'),
      )
    ).status,
  ).toBe(410);
});
