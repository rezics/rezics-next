import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { GRAPHS, hash, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { startHomeStack } from './feed-read-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { discloseConcept, shareClassifiedConcepts, type ClassifiedConcept, type ConceptContext }
  from './work-classification.ts';

interface Defined { scheme: string; schemeHead: string; concept: string; sense: string; definitionRevision: string }
interface Choices { languages: string[]; groups: { type: string; concepts: { id: string; name: { value: string };
  broader: string | null; samples: { id: string }[] }[] }[] }
interface Suggestions { items: { id: string; realm: string; sampleWorks: { id: string }[];
  reason: { kind: string; concept?: { id: string; name: { value: string } | null } } }[] }

/** A private Work may be unreadable as a Statement subject; a public one must be accepted. */
async function acceptTopic(send: (method: string, path: string, body?: unknown) => Promise<Response>,
  read: <T>(response: Response, expected?: number) => Promise<T>, actor: string,
  work: { mainVersion: string }, term: ClassifiedConcept, interpretation: ConceptContext, required: boolean) {
  const recorded = await send('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
    predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    value: { kind: 'resource', iri: term.concept }, applicability: [],
    interpretation: { kind: 'explicit', context: interpretation.context,
      semanticRevision: interpretation.semanticRevision },
    evidence: [], actingSubject: actor,
  });
  if (!required && recorded.status !== 201) { await recorded.body?.cancel(); return; }
  const statement = await read<{ statement: string; meaningKey: string }>(recorded, 201);
  const decided = await send('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1',
    target: { kind: 'qualified-fact', meaningKey: statement.meaningKey, support: [statement.statement] },
    acceptance: { kind: 'global' }, outcome: 'accepted', expectedDecisionHead: null, actingSubject: actor,
  });
  if (required) await read(decided, 201);
  else await decided.body?.cancel();
}

test('G-431 onboarding offers the shared scheme\'s Concepts by type with covers, and suggests Realms whose Works '
  + 'carry the chosen Concepts or narrower ones', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('onboarding-concepts');
  try {
    const { stack, author, call, json } = home;
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['context:create:root', 'context.create'], [`statement:speak:${author.actor}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide'], ['space:create:root', 'space.create']] as const) {
      await author.grant(scope, action);
    }
    const label = (en: string, zh: string) => [{ language: 'en', value: en }, { language: 'zh-Hans', value: zh }];
    const define = async (labels: { language: string; value: string }[], broader: string[],
      scheme: { id: string; expectedHead: string } | null) => json<Defined>(await call('POST',
      '/v1/classification-vocabulary', { profile: 'classification-proposition-v2', scheme, labels,
        alternativeLabels: [], broader, narrower: [], actingSubject: author.actor }, author.token), 201);
    // A shared scheme: Fiction › Fantasy, and Cooking. Fiction itself classifies no Work.
    const fiction = await define(label('Onboarding fiction', '入门小说'), [], null);
    const fantasy = await define(label('Onboarding fantasy', '入门玄幻'), [fiction.concept],
      { id: fiction.scheme, expectedHead: fiction.schemeHead });
    const cooking = await define(label('Onboarding cooking', '入门烹饪'), [],
      { id: fantasy.scheme, expectedHead: fantasy.schemeHead });
    for (const term of [fiction, fantasy, cooking]) {
      await discloseConcept(stack.accessPool, author.principal, author.actor, term.concept);
    }
    const [novel, epic, stew] = [await stack.publicWork(author.actor, ['zh-Hans'], '入门小说作品'),
      await stack.publicWork(author.actor, ['en'], 'Onboarding epic'),
      await stack.publicWork(author.actor, ['en'], 'Onboarding stew')];
    const hidden = await stack.privateWork(author.actor, 'Onboarding private draft');
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(novel.work)} a schema:Book . ${iri(epic.work)} a schema:Book . ${iri(stew.work)} a schema:Recipe . } }`);
    const send = (method: string, path: string, body?: unknown) => call(method, path, body, author.token);
    const interpretation = await shareClassifiedConcepts(send, json, author.actor, [fantasy, cooking]);
    for (const [work, term] of [[novel, fantasy], [epic, fantasy], [stew, cooking], [hidden, fantasy]] as const) {
      await acceptTopic(send, json, author.actor, work, term, interpretation, work !== hidden);
    }

    // Choices: the locale's language first; Concepts named in it, grouped by type, each with public examples.
    const choices = await json<Choices>(await call('GET', '/v1/onboarding/choices?locale=zh-Hans'));
    expect(choices.languages[0]).toBe('zh-Hans');
    const books = choices.groups.find(group => group.type === 'https://schema.org/Book')!;
    const recipes = choices.groups.find(group => group.type === 'https://schema.org/Recipe')!;
    const offered = books.concepts.find(concept => concept.id === fantasy.concept)!;
    expect(offered.name.value).toBe('入门玄幻');
    expect(offered.samples.map(sample => sample.id).sort()).toEqual([novel.work, epic.work].sort());
    expect(recipes.concepts.find(concept => concept.id === cooking.concept)?.samples.map(sample => sample.id))
      .toEqual([stew.work]);
    // Fiction classifies nothing public, so it is not a choice and not shown as Fantasy's broader.
    expect(choices.groups.some(group => group.concepts.some(concept => concept.id === fiction.concept))).toBe(false);
    expect(offered.broader).toBeNull();

    // A Realm that adopted the novel is suggested for Fiction, through its narrower Fantasy.
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'Onboarding readers', capabilities: ['realm'], actingSubject: author.actor }, author.token), 201);
    const empty = await json<{ realm: string }>(await call('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'Onboarding empty', capabilities: ['realm'], actingSubject: author.actor }, author.token), 201);
    const selection = { context: { kind: 'realm-local' as const, id: realm.realm }, work: novel.work,
      mainVersion: novel.mainVersion, contribution: novel.variants[0]!.contribution,
      publicationDecision: novel.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review' as const, actingSubject: author.actor };
    expect((await selectRealmLocal(stack.env, stack.admission(author.actor, `publication:adopt:${realm.realm}`,
      'publication.adopt', realmSelectionDigest(selection)), selection)).outcome).toBe('succeeded');
    await waitForRealmDirectory(stack.env, () => call('GET', '/v1/realms'),
      page => page.items.some(item => item.id === realm.realm));
    const suggested = await json<Suggestions>(await call('GET',
      `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(fiction.concept)}&languages=zh-Hans&locale=en`));
    expect(suggested.items).toContainEqual(expect.objectContaining({ realm: realm.realm,
      reason: { kind: 'matching-concept', concept: { id: fiction.concept,
        name: expect.objectContaining({ value: 'Onboarding fiction' }) } },
      sampleWorks: [expect.objectContaining({ id: novel.work })] }));
    expect(suggested.items.some(item => item.realm === empty.realm)).toBe(false);
    // Its Works carry Fantasy, which is neither Cooking nor narrower than it.
    const unrelated = await json<Suggestions>(await call('GET',
      `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(cooking.concept)}`));
    expect(unrelated.items.find(item => item.realm === realm.realm)?.reason.kind).not.toBe('matching-concept');
    // Without choices every suggestion is popular.
    const popular = await json<Suggestions>(await call('GET', '/v1/onboarding/suggested-follows'));
    expect(popular.items.every(item => item.reason.kind === 'popular')).toBe(true);

    // Global acceptance alone never discloses a classification. The same public
    // Work and Realm make each hidden association an otherwise eligible match.
    const unknown = await define(label('Onboarding unknown hint', '入门未知提示'), [],
      { id: cooking.scheme, expectedHead: cooking.schemeHead });
    const major = await define(label('Onboarding major spoiler', '入门重大剧透'), [],
      { id: unknown.scheme, expectedHead: unknown.schemeHead });
    const privateMeaning = await define(label('Onboarding private meaning', '入门私密语义'), [],
      { id: major.scheme, expectedHead: major.schemeHead });
    const publicInterpretation = await shareClassifiedConcepts(send, json, author.actor, [unknown, major, fiction]);
    for (const term of [unknown, major, fiction]) {
      await acceptTopic(send, json, author.actor, novel, term, publicInterpretation, true);
    }
    await new AccessJudgments(stack.accessPool).declareHint(author.principal, {
      concept: major.concept, context: { kind: 'global' }, hint: 'major', expectedGeneration: '0',
      actingSubject: author.actor, idempotencyKey: randomUUID(),
      requestDigest: hash(JSON.stringify([major.concept, { kind: 'global' }, 'major'])),
    });
    await discloseConcept(stack.accessPool, author.principal, author.actor, privateMeaning.concept);
    const privateInterpretation = await json<ConceptContext>(await send('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: null,
      entries: [{ target: privateMeaning.concept, relation: CLASSIFIED_AS, state: 'defined',
        definition: privateMeaning.definitionRevision, applicability: [] }], actingSubject: author.actor,
    }), 201);
    await author.grant(`context:read:${privateInterpretation.context}`, 'context.read');
    await acceptTopic(send, json, author.actor, novel, privateMeaning, privateInterpretation, true);

    const guardedChoices = await json<Choices>(await call('GET', '/v1/onboarding/choices'));
    for (const term of [unknown, major, privateMeaning]) {
      expect(guardedChoices.groups.some(group => group.concepts.some(concept => concept.id === term.concept)))
        .toBe(false);
      const guarded = await json<Suggestions>(await call('GET',
        `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(term.concept)}`));
      expect(guarded.items.find(item => item.realm === realm.realm)?.reason.kind).toBe('popular');
      expect(guarded.items.some(item => item.reason.concept?.id === term.concept)).toBe(false);
    }

    // An accepted, explicitly non-spoiler Concept is eligible until its
    // protection head withholds it; that also hides it as a broader choice.
    const visibleFiction = guardedChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === fiction.concept)!;
    expect(visibleFiction.samples.map(sample => sample.id)).toEqual([novel.work]);
    expect(guardedChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === fantasy.concept)?.broader).toBe(fiction.concept);
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(fiction.concept)} rv:protectionHead ${iri(`https://rezics.com/id/${randomUUID()}`)} . }
    }`);
    const withheldChoices = await json<Choices>(await call('GET', '/v1/onboarding/choices'));
    expect(withheldChoices.groups.some(group => group.concepts.some(concept => concept.id === fiction.concept)))
      .toBe(false);
    expect(withheldChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === fantasy.concept)?.broader).toBeNull();
    const withheld = await json<Suggestions>(await call('GET',
      `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(fiction.concept)}`));
    expect(withheld.items.find(item => item.realm === realm.realm)?.reason.kind).toBe('popular');
    expect(withheld.items.some(item => item.reason.concept?.id === fiction.concept)).toBe(false);

    // Unaccepted proposals can fill a classification page. Keep the existing
    // accepted topic, and find another accepted topic after that page too.
    const proposals: Defined[] = [];
    let scheme = { id: privateMeaning.scheme, expectedHead: privateMeaning.schemeHead };
    for (let index = 0; index < 21; index++) {
      const proposal = await define(label(`Onboarding proposal ${index}`, `入门提案 ${index}`), [], scheme);
      proposals.push(proposal);
      scheme = { id: proposal.scheme, expectedHead: proposal.schemeHead };
    }
    const rawStatement = (work: { mainVersion: string }, term: ClassifiedConcept) => `
      ${iri(`https://rezics.com/id/${randomUUID()}`)} a rdf:Statement ;
        rdf:subject ${iri(work.mainVersion)} ; rdf:predicate <${CLASSIFIED_AS}> ; rdf:object ${iri(term.concept)} ;
        rv:statementState rv:Active ; rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
        rv:interpretationDefinition ${iri(term.definitionRevision)} .`;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${proposals.map(term => rawStatement(novel, term)).join('\n')} }
    }`);
    const afterProposals = await define(label('Onboarding beyond proposals', '入门提案之后'), [], scheme);
    // Definitions use UUIDv7 identities, so this accepted Sense follows all
    // twenty-one proposals in the classification read's STR(?sense) order.
    expect(proposals.every(term => term.sense < afterProposals.sense)).toBe(true);
    await discloseConcept(stack.accessPool, author.principal, author.actor, afterProposals.concept);
    const afterInterpretation = await shareClassifiedConcepts(send, json, author.actor, [afterProposals]);
    await acceptTopic(send, json, author.actor, novel, afterProposals, afterInterpretation, true);
    const pagedChoices = await json<Choices>(await call('GET', '/v1/onboarding/choices'));
    expect(pagedChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === fantasy.concept)?.samples.map(sample => sample.id).sort())
      .toEqual([novel.work, epic.work].sort());
    expect(pagedChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === afterProposals.concept)?.samples.map(sample => sample.id))
      .toEqual([novel.work]);
    for (const term of [fantasy, afterProposals]) {
      const pagedSuggestions = await json<Suggestions>(await call('GET',
        `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(term.concept)}`));
      expect(pagedSuggestions.items).toContainEqual(expect.objectContaining({ realm: realm.realm,
        reason: { kind: 'matching-concept', concept: { id: term.concept,
          name: expect.objectContaining({ value: expect.any(String) }) } },
        sampleWorks: [expect.objectContaining({ id: novel.work })] }));
    }

    // Four earlier raw proposals must not crowd a fifth accepted Work out of
    // the Concept's samples. Sort identities in the candidate seek's STR order.
    const refillTopic = await define(label('Onboarding refilled samples', '入门补充示例'), [],
      { id: afterProposals.scheme, expectedHead: afterProposals.schemeHead });
    await discloseConcept(stack.accessPool, author.principal, author.actor, refillTopic.concept);
    const refillWorks = [];
    for (let index = 0; index < 5; index++) {
      refillWorks.push(await stack.publicWork(author.actor, ['en'], `Onboarding sample candidate ${index}`));
    }
    refillWorks.sort((left, right) => left.work < right.work ? -1 : left.work > right.work ? 1 : 0);
    const acceptedSample = refillWorks[4]!;
    expect(refillWorks.slice(0, 4).every(work => work.work < acceptedSample.work)).toBe(true);
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} {
        ${refillWorks.map(work => `${iri(work.work)} a schema:Book .`).join('\n')}
        ${refillWorks.slice(0, 4).map(work => rawStatement(work, refillTopic)).join('\n')}
      }
    }`);
    const refillInterpretation = await shareClassifiedConcepts(send, json, author.actor, [refillTopic]);
    await acceptTopic(send, json, author.actor, acceptedSample, refillTopic, refillInterpretation, true);
    const refilledChoices = await json<Choices>(await call('GET', '/v1/onboarding/choices'));
    expect(refilledChoices.groups.flatMap(group => group.concepts)
      .find(concept => concept.id === refillTopic.concept)?.samples.map(sample => sample.id))
      .toEqual([acceptedSample.work]);

    // A visible chosen parent cannot borrow a match from a withheld narrower
    // Concept, even when that narrower classification remains accepted.
    const publicParent = await define(label('Onboarding public parent', '入门公开上级'), [],
      { id: refillTopic.scheme, expectedHead: refillTopic.schemeHead });
    const protectedChild = await define(label('Onboarding protected child', '入门受保护下级'), [publicParent.concept],
      { id: publicParent.scheme, expectedHead: publicParent.schemeHead });
    for (const term of [publicParent, protectedChild]) {
      await discloseConcept(stack.accessPool, author.principal, author.actor, term.concept);
    }
    const childInterpretation = await shareClassifiedConcepts(send, json, author.actor, [protectedChild]);
    await acceptTopic(send, json, author.actor, novel, protectedChild, childInterpretation, true);
    const parentQuery = `/v1/onboarding/suggested-follows?concepts=${encodeURIComponent(publicParent.concept)}&locale=en`;
    const childMatch = await json<Suggestions>(await call('GET', parentQuery));
    expect(childMatch.items).toContainEqual(expect.objectContaining({ realm: realm.realm,
      reason: { kind: 'matching-concept', concept: { id: publicParent.concept,
        name: expect.objectContaining({ value: 'Onboarding public parent' }) } },
      sampleWorks: [expect.objectContaining({ id: novel.work })] }));
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(protectedChild.concept)} rv:protectionHead ${iri(`https://rezics.com/id/${randomUUID()}`)} . }
    }`);
    const protectedMatch = await json<Suggestions>(await call('GET', parentQuery));
    expect(protectedMatch.items.find(item => item.realm === realm.realm)?.reason.kind).toBe('popular');
    expect(protectedMatch.items.some(item => item.reason.concept?.id === publicParent.concept)).toBe(false);

    // Any BCP 47 language the reader reads is accepted; a malformed or repeated one is not, nor a foreign Concept ID.
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=yue&languages=pt-BR')).status).toBe(200);
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=en&languages=en')).status).toBe(400);
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=Not_a_tag')).status).toBe(400);
    expect((await call('GET', `/v1/onboarding/suggested-follows?concepts=urn:example:${randomUUID()}`)).status).toBe(400);
  } finally { await home.stop(); }
}, 300_000);
