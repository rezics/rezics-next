import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { MergedIdentity } from '../../../services/main/src/modules/identity-merge/resolution.ts';
import { createMainApp } from '../../../services/main/src/app.ts';

/** Native read acceptance uses fixture identity edges; reviewed merge execution
 * and the complete SAO reconciliation journey have separate acceptance. */
test('G836: public old IDs, slugs and retained revisions explain a merge without replacing original bytes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `g-836-address-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read address:claim');
  const app = createMainApp(f.env.fuseki, { environment: f.env, access: f.access, account: f.account.verifier });
  const anonymous = (path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
    method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }));
  try {
    const source = await f.adoptWork(await f.propose('OL836001W', [], 'Sword Art Online 1 — Aincrad'));
    const survivor = await f.adoptWork(await f.propose('OL836002W', [], 'ソードアート・オンライン 1 アインクラッド'));
    // Publication of this read fixture is independent of the merge executor.
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(source.work)} rv:catalogueVisible true . ${iri(survivor.work)} rv:catalogueVisible true } }`);
    for (const work of [source.work, survivor.work]) await f.grant(`work:read:${work}`, 'work.read');
    await f.grant(`address:claim:${source.work}`, 'address.claim');
    const slug = `sao-836-${randomUUID().slice(0, 8)}`;
    const address = await f.json<{ revision: string }>(await f.call('POST', '/v1/addresses/claims',
      { profile: 'alias-write-v1',operation: 'claim',scope: 'work',holder: source.work,alias: slug,
        expectedRevision: null,actingSubject: f.actor }), 201);
    const revisionPath = `/v1/revisions/${shortId(source.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const mainPath = `/v1/main-versions/${shortId(source.mainVersion)}/revisions/${shortId(source.mainRevision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const original = await f.json<Record<string, unknown>>(await f.call('GET', revisionPath), 200);
    const originalMain = await f.json<Record<string, unknown>>(await f.call('GET', mainPath), 200);
    const addressPath = `/v1/addresses/resolve?scope=work&key=${slug}`;
    const addressRevisionPath = `/v1/addresses/revisions/${address.revision}?scope=work&key=${slug}`;
    const originalAddress = await f.json<Record<string, unknown>>(await anonymous(addressRevisionPath), 200);
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(source.work)} rv:mergedInto ${iri(survivor.work)} } }`);
    const resolution: MergedIdentity = { state: 'merged', source: source.work, survivor: survivor.work, hops: 1 };
    const oldId = await f.json<{ reference: string; status: string; resolution: MergedIdentity }>(
      await anonymous(`/v1/resources/${shortId(source.work)}`), 200);
    expect(oldId).toMatchObject({ reference: source.work, status: 'merged', resolution });
    const batch = await f.json<{ summaries: unknown[] }>(await anonymous('/v1/resources/summaries',
      { profile: 'resource-summary-batch-v1', resources: [source.work, survivor.work, source.work] }), 200);
    expect(batch.summaries).toHaveLength(3);
    expect(batch.summaries[0]).toMatchObject({ reference: source.work, status: 'available', resolution });
    expect(batch.summaries[2]).toEqual(batch.summaries[0]);
    const route = await f.json<{ state: string; holder: string; resolution: MergedIdentity }>(
      await anonymous(addressPath), 200);
    expect(route).toMatchObject({ state: 'current', holder: source.work, resolution });
    // Survivor deliberately has no slug: identity resolution still succeeds.
    expect(await f.json(await anonymous(addressRevisionPath), 200))
      .toEqual({ ...originalAddress, resolution });
    expect(await f.json(await f.call('GET', revisionPath), 200)).toEqual({ ...original, resolution });
    expect(await f.json(await f.call('GET', mainPath), 200)).toEqual({ ...originalMain, resolution });
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(survivor.work)} rv:catalogueVisible true } }`);
    // No survivor identity or metadata escapes through a public source alias.
    expect((await anonymous(`/v1/resources/${shortId(source.work)}`)).status).toBe(404);
    expect((await anonymous(addressPath)).status).toBe(404);
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(survivor.work)} rv:catalogueVisible true ; rv:mergedInto ${iri(source.work)} } }`);
    expect((await anonymous(`/v1/resources/${shortId(source.work)}`)).status).toBe(503);
    expect((await anonymous(addressPath)).status).toBe(503);
    // Unmerge read projection restores old identities, addresses and bytes.
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(source.work)} rv:mergedInto ${iri(survivor.work)} .
        ${iri(survivor.work)} rv:mergedInto ${iri(source.work)} } }`);
    expect(await f.json(await f.call('GET', revisionPath), 200)).toEqual(original);
    expect(await f.json(await f.call('GET', mainPath), 200)).toEqual(originalMain);
    expect(await f.json(await anonymous(addressRevisionPath), 200)).toEqual(originalAddress);
    expect(await f.json(await anonymous(addressPath), 200)).toMatchObject({ state: 'current', holder: source.work });
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
},30_000);
