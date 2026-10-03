import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { uuidToSid } from '@rezics/model/address/sid';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AliasRegistry, type AliasScope } from '../src/modules/address/registry.ts';
import type { AddressScope } from '../src/modules/address/resolution.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { addressRoutes } from '../src/routes/addresses.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uuid = '1ce436f9-e7eb-4155-988e-d23a8514150f';
const holder = `https://rezics.com/id/${uuid}`;
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const sid = uuidToSid(uuid);
const forms = [uuid, uuid.toUpperCase(), '1Ce436F9-e7Eb-4155-988E-d23A8514150f'];
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']) => ({
  results: { bindings },
});

function registry() {
  const queries: string[] = [];
  const query = async (sql: string) => {
    queries.push(sql);
    return { rows: [], rowCount: sql.includes('access.recovery_fence') ? 1 : 0 };
  };
  const client = { query, release: () => {} };
  return {
    queries,
    names: new AliasRegistry({ query, connect: async () => client } as unknown as Pool),
  };
}

for (const scope of ['agent', 'space', 'work', `zone:${space}`] as const) {
  test.each(forms)(`G990: ${scope} identifies UUID %s before name comparison`, async (key) => {
    const f = registry();
    expect(await f.names.identify(scope, key)).toEqual({ holder, alias: null });
    expect(f.queries).toEqual([]);
  });
}

test('G990: every name scope preserves sid case instead of folding it as a name', async () => {
  const changed = sid.replace('Z', 'z');
  for (const scope of ['agent', 'space', 'work', `zone:${space}`] as AliasScope[]) {
    const f = registry();
    for (const suffix of ['', '-old-title']) {
      expect((await f.names.identify(scope, sid + suffix)).holder).toBe(holder);
      const other = await f.names.identify(scope, changed + suffix);
      expect(other.holder).not.toBeNull();
      expect(other.holder).not.toBe(holder);
    }
    expect(f.queries).toEqual([]);
  }
});

/** Real registry and resolver; only owner storage is replaced by bounded fixtures. */
function fixture(scope: AddressScope) {
  const names = registry().names;
  const type =
    scope === 'resource' || scope === 'concept' || scope.startsWith('zone:') ? 'concept' : scope;
  const pageSpace = scope === 'space' ? holder : space;
  const graphQueries: string[] = [];
  const references = (sql: string, variable: string) =>
    [
      ...(sql.match(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`))?.[1] ?? '').matchAll(
        /<([^>]+)>/g,
      ),
    ].map((match) => match[1]!);
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    addresses: names,
    fuseki: {
      query: async (sql: string) => {
        graphQueries.push(sql);
        if (sql.includes('ASK')) return { boolean: true };
        if (sql.includes('SELECT ?epoch ?sequence WHERE'))
          return rows([{ epoch: literal('epoch'), sequence: literal('7') }]);
        if (sql.includes('SELECT DISTINCT ?space ?zone'))
          return rows([{ space: uri(pageSpace), zone: uri(zone) }]);
        if (sql.includes('SELECT DISTINCT ?resource ?space ?realm ?zone'))
          return rows(
            references(sql, 'resource')
              .filter((ref) => [pageSpace, zone].includes(ref))
              .map((ref) => ({ resource: uri(ref), space: uri(pageSpace), zone: uri(zone) })),
          );
        if (sql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
          const found = references(sql, 'r').filter((ref) =>
            [holder, pageSpace, zone].includes(ref),
          );
          return rows(
            found.length
              ? found.map((ref) => ({
                  epoch: literal('epoch'),
                  sequence: literal('7'),
                  r: uri(ref),
                  type: literal(ref === holder ? type : ref === zone ? 'zone' : 'space'),
                  public: literal('true'),
                  label: { ...literal('Reader'), 'xml:lang': 'en' },
                }))
              : [{ epoch: literal('epoch'), sequence: literal('7') }],
          );
        }
        if (sql.includes('SELECT DISTINCT ?resource ?space ?disclosure'))
          return rows(
            references(sql, 'resource')
              .filter((ref) => [pageSpace, zone].includes(ref))
              .map((ref) => ({
                resource: uri(ref),
                space: uri(pageSpace),
                disclosure: uri(RV + 'Public'),
              })),
          );
        if (sql.includes('SELECT ?resource ?space ?site'))
          return rows(
            references(sql, 'resource').map((ref) => ({
              resource: uri(ref),
              space: uri(pageSpace),
              site: literal('true'),
            })),
          );
        if (sql.includes('SELECT ?zone ?segment')) return rows([]);
        throw new Error(`Unexpected graph query: ${sql}`);
      },
    },
  } as unknown as WorkActivationEnvironment;
  const work = { environment: env } as MainWorkDependencies;
  return { graphQueries, app: new Elysia().use(addressRoutes(work)) };
}

for (const scope of ['agent', 'space', 'work', 'resource', 'concept', `zone:${space}`] as const) {
  test(`G990: Main does not resolve a case-altered sid as the ${scope} fixture`, async () => {
    const f = fixture(scope);
    const key = sid.replace('Z', 'z');
    const response = await f.app.handle(
      new Request(`http://main.local/v1/addresses/resolve?${new URLSearchParams({ scope, key })}`),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'address_not_found' });
  });
  test.each(forms)(
    `G990: Main resolves ${scope} UUID %s to the same canonical holder`,
    async (key) => {
      const f = fixture(scope);
      const response = await f.app.handle(
        new Request(
          `http://main.local/v1/addresses/resolve?${new URLSearchParams({ scope, key })}`,
        ),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({
        profile: 'address-resolution-v1',
        scope,
        key,
        status: 'resolved',
        holder,
        canonical: { key: sid, suffixSource: 'Reader' },
      });
      expect(f.graphQueries.join('\n')).not.toContain(key.toUpperCase());
    },
  );
}

test('G990: batch resolution returns each spelling with one canonical identity', async () => {
  const f = fixture('agent');
  const response = await f.app.handle(
    new Request('http://main.local/v1/addresses/resolutions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookups: forms.map((key) => ({ scope: 'agent', key })) }),
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).results).toEqual(
    forms.map((key) => ({
      profile: 'address-resolution-v1',
      scope: 'agent',
      key,
      status: 'resolved',
      holder,
      state: 'current',
      canonical: { prefix: '/a/', key: sid, suffixSource: 'Reader' },
    })),
  );
});
