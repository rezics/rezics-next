import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { reasonSemanticFacts, SEMANTIC_REASONING_PROFILE,
  type ReasoningFact } from '../../../services/main/src/modules/semantic/reasoning.ts';

const RV = 'https://rezics.com/vocab/';
const OWL = 'http://www.w3.org/2002/07/owl#';

test('MODEL19/MODEL20: identity axioms are refused and Source/Realm closure cannot qualify or authorize facts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `semantic-reasoning-${randomUUID()}`));
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const write = async (state: object, target?: string, expectedHead: string | null = null) => f.call('POST',
      '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor,
        ...(target ? { target } : {}), expectedHead, state }, randomUUID());
    const created = async () => {
      const response = await write({ component: 'resource', types: ['https://schema.org/Person'], properties: [] });
      expect(response.status).toBe(201);
      return await response.json() as { component: string; revision: string };
    };
    const left = await created();
    const right = await created();
    const nativeIds = await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?left ?right WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(left.component)} rv:semanticHead ?left .
        ${iri(right.component)} rv:semanticHead ?right .
      }
    }`);
    expect(nativeIds.results?.bindings).toHaveLength(1);
    expect(nativeIds.results?.bindings[0]?.left?.value).toBe(left.revision);
    expect(nativeIds.results?.bindings[0]?.right?.value).toBe(right.revision);
    expect(left.component).not.toBe(right.component);

    await f.grant(`semantic:read:${left.component}`, 'semantic.read');
    const read = (target: string) => f.call('GET',
      `/v1/semantic/resources/${shortId(target)}?actingSubject=${encodeURIComponent(f.actor)}`);
    expect((await read(left.component)).status).toBe(200);
    expect((await read(right.component)).status).toBe(404);

    const before = Number((await f.accessPool.query("SELECT count(*) FROM access.admission WHERE action = 'semantic.change'"))
      .rows[0]!.count);
    for (const property of [`${OWL}sameAs`, `${OWL}hasKey`]) {
      const response = await write({ component: 'resource', types: ['https://schema.org/Person'], properties: [
        { predicate: property, value: { kind: 'resource', ref: right.component } },
      ] }, left.component, left.revision);
      expect(response.status).toBe(422);
      expect((await response.json() as { code: string }).code).toBe('identity_axiom');
    }
    for (const type of [`${OWL}FunctionalProperty`, `${OWL}InverseFunctionalProperty`]) {
      const response = await write({ component: 'resource', types: [type], properties: [] }, left.component, left.revision);
      expect(response.status).toBe(422);
      expect((await response.json() as { code: string }).code).toBe('identity_axiom');
    }
    expect(Number((await f.accessPool.query("SELECT count(*) FROM access.admission WHERE action = 'semantic.change'"))
      .rows[0]!.count)).toBe(before);
    expect((await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(left.component)} <${OWL}sameAs> ${iri(right.component)} } }`)).boolean).toBe(false);
    expect((await read(right.component)).status).toBe(404);

    const activeGeneration = await readActiveModelGeneration(f.env.fuseki);
    const source = { kind: 'source', id: 'source:test-import' } as const;
    const selectedRealm = { kind: 'realm', id: 'https://rezics.com/id/00000000-0000-7000-8000-000000000099' } as const;
    const partial = reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: activeGeneration,
      selectedScopes: [source, selectedRealm], closureState: 'partial', candidateCount: 1,
      facts: [{ id: 'source-person', subject: left.component, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person', scope: source },
      { id: 'realm-person', subject: right.component, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person', scope: selectedRealm }] satisfies ReasoningFact[] });
    expect(partial).toMatchObject({ status: 'partial', inferences: [], exactCount: null,
      accepted: false, authorizes: false, fallbackUsed: false, modelGeneration: activeGeneration.generation });
  } finally { await f.close(); }
});
