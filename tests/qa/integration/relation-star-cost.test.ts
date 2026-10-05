import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readExactDefinition, starConflict, type OccurrenceState } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';

const scales = [1_000, 10_000, 40_000];
const BATCH = 2_000;

type Changed = { component: string; revision: string };

/** The star guard runs inside the graph write lock every other write waits on, so its cost must follow the
 * written participants' own history and never the number of occurrences in the graph. */
test('star guard: constant graph work per write at 1k, 10k and 40k occurrences of one definition', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', 'relation-star-cost-qa', Bun.env.REZICS_QA_RUN_ID), 'openid work:create work:edit work:read');
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('relation:create:root', 'relation.change');
    const notation = `star-cost-${randomUUID()}`;
    const roles = ['variant', 'hub'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false }));
    const created = await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'definition', kind: 'relation', notation, roles, star: { leaf: 'variant', hub: 'hub' } } }), 201);
    const definition = (await readExactDefinition(f.env, created.revision, systemDisclosure))!;
    const role = (key: string) => `${definition.definition}/role/${key}`;
    const rdfType = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
    const loadOccurrences = async (count: number) => {
      for (let at = 0; at < count; at += BATCH) {
        const current: string[] = [], revisions: string[] = [];
        for (let index = 0; index < Math.min(BATCH, count - at); index++) {
          const [occurrence, head, leafPart, hubPart] = [nativeId(), nativeId(), nativeId(), nativeId()];
          current.push(`${iri(occurrence)} ${rdfType} <${RV}RelationOccurrence> ; <${RV}relationDefinition> ${iri(definition.revision)} ;
            <${RV}occurrenceHead> ${iri(head)} .`);
          revisions.push(`${iri(head)} <${RV}component> ${iri(occurrence)} ; <${RV}relationDefinition> ${iri(definition.revision)} ;
            <${RV}lifecycle> <${RV}Active> ; <${RV}participation> ${iri(leafPart)}, ${iri(hubPart)} .
            ${iri(leafPart)} <${RV}occurrence> ${iri(occurrence)} ; <${RV}role> ${iri(role('variant'))} ; <${RV}participant> ${iri(nativeId())} .
            ${iri(hubPart)} <${RV}occurrence> ${iri(occurrence)} ; <${RV}role> ${iri(role('hub'))} ; <${RV}participant> ${iri(nativeId())} .`);
        }
        await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${current.join('\n')} }
          GRAPH ${iri(GRAPHS.revisions)} { ${revisions.join('\n')} } }`);
      }
    };
    const written: OccurrenceState = { definition: definition.revision, lifecycle: 'active', applicability: [],
      participations: [{ role: role('variant'), participant: { kind: 'resource', ref: nativeId() }, iri: '' },
        { role: role('hub'), participant: { kind: 'resource', ref: nativeId() }, iri: '' }] };
    const guard = starConflict(definition, nativeId(), written);
    const measure = async () => {
      const samples: number[] = [];
      for (let run = 0; run < 7; run++) {
        const started = performance.now();
        const result = await f.nativeFuseki.query(`PREFIX rv: <${RV}> ASK ${guard}`);
        samples.push(performance.now() - started);
        expect(result.boolean).toBe(false);
      }
      return samples.sort((a, b) => a - b)[3]!;
    };
    let loaded = 0;
    const medians: number[] = [];
    for (const scale of scales) {
      await loadOccurrences(scale - loaded);
      loaded = scale;
      medians.push(await measure());
    }
    console.log('star guard median ms at', scales.join('/'), medians.map(ms => ms.toFixed(1)).join('/'));
    // Constant work: the largest graph is no slower than a small multiple of the smallest, within a floor
    // that absorbs timer and network noise. A scan of every occurrence grows with the graph instead.
    expect(medians[2]!).toBeLessThan(Math.max(medians[0]! * 4, 25));
  } finally { await f.close(); }
}, 900_000);
