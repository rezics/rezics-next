import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { type OccurrenceState } from '../src/modules/relation/change.ts';
import { readPostIdentification, readPostIdentifications } from '../src/modules/post/identification-read.ts';
import { identificationEvidenceLink } from '../src/modules/post/identification-schema.ts';
import { workRead, type ReadRow } from '../src/modules/work/read-session.ts';

const directory = mkdtempSync('.temp/post-identification-fences-');
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const id = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const post = id(1), works = [id(2), id(3)], relation = id(4), definition = id(5), definitionRevision = id(6);
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const result = (bindings: ReadRow[]): SparqlResult => ({ results: { bindings } });

function fixture() {
  const state = { head: id(10), sequence: 1, operation: 'selected-operation', part: works[0]!,
    evidence: 'separate-authorship' as 'separate-authorship' | 'independent-citation',
    definitionRevision, recoveryChecks: 0 };
  const definitionManifest = prepareComponent(directory, definition, {
    component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
    notation: 'composition-part', roles: ['part', 'whole'].map(key => ({ key, minParticipants: 1,
      maxParticipants: 1, ordered: false })),
  }, PROFILES.definition);
  const occurrence = (): OccurrenceState => ({ definition: state.definitionRevision,
    lifecycle: 'active', applicability: [], evidence: identificationEvidenceLink(post, state.operation,
      { kind: state.evidence }), participations: [
      { iri: id(11), role: `${definition}/role/part`, participant: { kind: 'resource', ref: state.part } },
      { iri: id(12), role: `${definition}/role/whole`, participant: { kind: 'resource', ref: id(13) } },
    ] });
  const graph = new FusekiClient('http://graph.invalid/post-identification');
  graph.commandHealth = async () => ({ profiles: { 'work-metadata-v1': 'a'.repeat(64) } }) as never;
  graph.query = async body => {
    if (body.includes('SELECT ?resource ?head') || body.includes('SELECT ?work ?head')) {
      const variable = body.includes('SELECT ?resource ?head') ? 'resource' : 'work';
      return result(works.filter(work => body.includes(`<${work}>`))
        .map(work => ({ [variable]: uri(work), head: uri(id(40 + works.indexOf(work))) })));
    }
    if (body.includes('SELECT ?head ?manifest WHERE')) return result([{ head: uri(state.head),
      manifest: uri(`urn:rezics:sha256:${prepareComponent(directory, relation, occurrence(), PROFILES.relation)}`) }]);
    if (body.includes('SELECT ?p ?o WHERE')) return result([
      { p: uri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), o: uri(`${RV}RelationOccurrence`) },
      { p: uri(`${RV}relationDefinition`), o: uri(state.definitionRevision) },
      { p: uri(`${RV}occurrenceHead`), o: uri(state.head) },
    ]);
    if (body.includes('SELECT ?definition ?manifest')) return result([{ definition: uri(definition),
      manifest: uri(`urn:rezics:sha256:${definitionManifest}`) }]);
    if (body.includes('SELECT ?head ?publisher ?label')) return result([{ head: uri(id(20)),
      publisher: uri(id(21)), label: { ...literal('Unchanged Post'), 'xml:lang': 'en' }, public: literal('true') }]);
    if (body.includes('SELECT DISTINCT ?book ?occurrence')) return result([]);
    if (body.includes('SELECT ?work ?main ?structure (MIN')) return result([{ work: uri(works[0]!),
      main: uri(id(30)), structure: uri(id(31)), occurrence: uri(id(32)) }]);
    if (body.includes('SELECT ?relation WHERE')) return result([{ relation: uri(relation) }]);
    // These Works have no catalogue synopsis before metadata is authored.
    if (body.includes('SELECT ?text WHERE')) return result([]);
    if (body.includes('SELECT ?head ?main ?mainHead')) {
      const index = body.includes(`<${works[1]}>`) ? 1 : 0;
      return result([{ head: uri(id(40 + index)), main: uri(id(50 + index)),
        mainHead: uri(id(60 + index)), public: literal('true') }]);
    }
    if (body.includes('SELECT ?structuredDecision ?structuredSource') || body.includes('SELECT ?selection ?language'))
      return result([]);
    if (body.includes('SELECT ?work ?parent')) return result(works.filter(work => body.includes(`<${work}>`))
      .map(work => ({ work: uri(work) })));
    if (body.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([
      { epoch: literal('epoch'), sequence: literal(String(state.sequence)) },
      ...works.filter(work => body.includes(`<${work}>`)).map(work => ({ r: uri(work), type: literal('work'),
        work: uri(work), head: uri(id(40 + works.indexOf(work))), public: literal('true'),
        label: { ...literal(work === works[0] ? 'First Work' : 'Second Work'), 'xml:lang': 'en' } })),
    ]);
    if (body.includes('SELECT ?epoch ?sequence')) return result([{ epoch: literal('epoch'),
      sequence: literal(String(state.sequence)) }]);
    throw new Error(`Unexpected identification query: ${body}`);
  };
  const deps = { environment: { fuseki: graph, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {
    assertRecoveryOpen: async () => { state.recoveryChecks++; },
  } } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: target.work, head: id(40 + works.indexOf(target.work)), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const request = new Request(`http://main.test/v1/post-identifications/${relation.slice(-36)}`);
  return { state, deps, request };
}

for (const changed of ['binding', 'participants', 'evidence'] as const) {
  test(`Post identification replays changed ${changed} while referenced Post and Work heads stay unchanged`, async () => {
    const f = fixture(); let attempts = 0;
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++;
      const page = await readPostIdentification(session, relation.slice(-36));
      if (attempts === 1) {
        f.state.head = id(70);
        if (changed === 'binding') f.state.definitionRevision = id(71);
        if (changed === 'participants') f.state.part = works[1]!;
        if (changed === 'evidence') f.state.evidence = 'independent-citation';
        f.state.sequence++;
      }
      return page;
    });
    expect(attempts).toBe(2);
    expect(page.relationRevision).toBe(id(70));
    expect(page.post).toBe(post);
    expect(page.work).toBe(changed === 'participants' ? works[1] : works[0]);
    expect(page.evidence.kind).toBe(changed === 'evidence' ? 'independent-citation' : 'separate-authorship');
    expect(page.sourcePosition.sequence).toBe('2');
    expect(f.state.recoveryChecks).toBeGreaterThanOrEqual(2);
  });
}

for (const changed of ['matching operation removed', 'matching operation admitted', 'unchanged operation'] as const) {
  test(`Post operation inventory fences selected membership: ${changed}`, async () => {
    const f = fixture(); let attempts = 0;
    if (changed === 'matching operation admitted') f.state.operation = 'other-operation';
    const page = await workRead(f.deps, f.request, {}, async session => {
      attempts++;
      const page = await readPostIdentifications(session, post, 'selected-operation');
      if (attempts === 1) {
        f.state.head = id(70);
        f.state.evidence = 'independent-citation';
        if (changed === 'matching operation removed') f.state.operation = 'other-operation';
        if (changed === 'matching operation admitted') f.state.operation = 'selected-operation';
        f.state.sequence++;
      }
      return page;
    });
    expect(attempts).toBe(changed === 'unchanged operation' ? 1 : 2);
    expect(page.items.map(item => item.work)).toEqual(changed === 'matching operation removed' ? [] : [works[0]]);
    expect(page.complete).toBe(true);
  });
}
