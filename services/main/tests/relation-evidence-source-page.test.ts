import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { associationEvidenceResult } from '../src/modules/relation/evidence-contract.ts';
import { projectRetainedAssociationCitation } from '../src/modules/relation/evidence-citation.ts';
import { AssociationEvidenceChanged } from '../src/modules/relation/evidence-cursor.ts';
import { readAssociationEvidencePage, selectAssociationEvidence,
  type AssociationEvidenceClaim, type AssociationEvidenceSupportReader } from '../src/modules/relation/evidence.ts';
import type { PublicRetainedFieldEvidence } from '../src/modules/source/retained-evidence.ts';
import { hash, RV } from '../src/modules/work/activate.ts';
import { WorkReadSession, WorkReadMoved } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = selectAssociationEvidence(id(1), id(2), { profile: 'association-evidence-v1',
  context: 'global', position: 'start', claim: id(1), claimRevision: id(2), limit: 1 });

/** Page/frontier behavior over a controlled admitted claim. Native ownership
 * and adoption are exercised separately; these owner doubles prove neither. */
function fixture() {
  let permitted = true, sourceGeneration = 1, mapping = hash('mapping'), coverage = id(30);
  const generation = `urn:rezics:model-generation:${hash('model')}`;
  const evidence = (): PublicRetainedFieldEvidence => ({ id: id(50), sourceWork: null,
    representationSha256: hash('frozen record'), locator: { pointer: '/authors/3/name' },
    attribution: { sourceName: 'openlibrary', sourceUrl: null, licence: null },
    rightsBasis: { basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: null, obligations: [],
      useScope: 'quotation', result: permitted ? 'supported' : 'undetermined', memberOrdinals: [0] },
    quote: permitted ? 'The same frozen field' : null, quoteWithheld: !permitted, language: { state: 'null' } });
  const deps = { environment: { lineage: { dataEpoch: 'epoch-one', routingEpoch: '1' }, fuseki: {
    query: async (query: string): Promise<SparqlResult> => {
      const uri = (value: string) => ({ type: 'uri', value }), literal = (value: string) => ({ type: 'literal', value });
      if (query.includes('SELECT ?generation WHERE')) return { results: { bindings: [{ generation: uri(generation) }] } };
      if (query.includes('SELECT ?manifest ?number')) return { results: { bindings: [{
        manifest: uri(`urn:rezics:sha256:${hash('model bytes')}`), number: literal('1'), entailment: uri(RV + 'NoEntailment'),
        digest: literal(hash(JSON.stringify({ family: 'model-generation-v1', manifest: hash('model') }))) }] } };
      throw new Error(`Unexpected source evidence page query: ${query.slice(0, 100)}`);
    } }, }, access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://test/v1/relations/one'), {},
    { dataEpoch: 'epoch-one', sequence: '21' });
  const claim = () => ({ occurrence: { kind: 'retained-credit', receipt: `urn:rezics:receipt:${hash('credit command')}`,
    manifest: `urn:rezics:sha256:${hash('credit bytes')}`, sourceValidation: [{ validationToken: hash('source origin') }], attribution: [],
    publicView: { mappingValidation: { validationToken: mapping }, coverage: { revision: coverage } } },
    assertion: { statement: id(3), revision: id(4) }, statement: null }) as unknown as AssociationEvidenceClaim;
  const owner: AssociationEvidenceSupportReader = {
    basis: async () => hash(JSON.stringify([sourceGeneration, permitted])),
    window: async (_session, _selection, _claim, after, limit) => {
      expect(limit).toBe(1);
      const offset = after ? Number(after.slice('source-physical:'.length)) : 0;
      return { items: offset === 0 ? [] : [projectRetainedAssociationCitation({
        support: id(9 + offset), supportIdentity: id(19 + offset), evidence: evidence() })],
      after: offset < 2 ? `source-physical:${offset + 1}` : null, complete: offset === 2 };
    },
  };
  return { session, claim, owner, permitted: (value: boolean) => { permitted = value; },
    generation: () => { sourceGeneration++; }, mapping: () => { mapping = hash('new mapping'); },
    coverage: () => { coverage = id(31); } };
}

test('independent supports of one record survive hidden-only windows and exact retained continuations', async () => {
  const f = fixture(), supports: string[] = [], steps: string[] = [], records: string[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 3; index++) {
    const session = f.session(), page = await readAssociationEvidencePage(session, selection, f.claim(), f.owner, cursor);
    expect(Value.Check(associationEvidenceResult, page)).toBe(true);
    expect(page.count.value).toBe(page.items.length);
    if (index === 0) { expect(page.items).toEqual([]); expect(page.complete).toBe(false); }
    for (const item of page.items) {
      if (!('kind' in item)) throw new Error('retained citation was replaced by manual evidence');
      supports.push(item.id); steps.push(item.supportIdentity); records.push(item.record);
      expect(item.sourceWork).toBeNull(); expect(item.locator).toEqual({ pointer: '/authors/3/name' });
      expect(item.language).toEqual({ state: 'null' });
    }
    await session.fenceDependencies();
    cursor = page.nextCursor ?? undefined;
    expect(page.complete).toBe(index === 2);
  }
  expect(supports).toEqual([id(10), id(11)]);
  expect(steps).toEqual([id(20), id(21)]);
  expect(records).toEqual([id(50), id(50)]);
  expect(cursor).toBeUndefined();
});

test('retained rights and support generation changes invalidate the final page and its continuation', async () => {
  const f = fixture(), opening = await readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner);
  const session = f.session(), shown = await readAssociationEvidencePage(session, selection, f.claim(), f.owner, opening.nextCursor!);
  expect(shown.items[0]?.quote).toBe('The same frozen field');
  f.permitted(false);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner, opening.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
  const restart = await readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner);
  const withheld = await readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner, restart.nextCursor!);
  const item = withheld.items[0];
  if (!item || !('kind' in item)) throw new Error('retained citation was replaced by manual evidence');
  expect({ id: item.id, record: item.record, quote: item.quote, quoteWithheld: item.quoteWithheld })
    .toEqual({ id: id(10), record: id(50), quote: null, quoteWithheld: true });
  f.generation();
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner, restart.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
});

test('a retained continuation binds exact current mapping and adoption coverage independently of the citation store', async () => {
  const f = fixture(), first = await readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner);
  f.mapping();
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner, first.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
  const restart = await readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner);
  f.coverage();
  await expect(readAssociationEvidencePage(f.session(), selection, f.claim(), f.owner, restart.nextCursor!))
    .rejects.toBeInstanceOf(AssociationEvidenceChanged);
});
