import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { startHomeStack } from './feed-read-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { shareClassifiedConcepts, type ClassifiedConcept, type ConceptContext } from './work-classification.ts';

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

    // Any BCP 47 language the reader reads is accepted; a malformed or repeated one is not, nor a foreign Concept ID.
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=yue&languages=pt-BR')).status).toBe(200);
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=en&languages=en')).status).toBe(400);
    expect((await call('GET', '/v1/onboarding/suggested-follows?languages=Not_a_tag')).status).toBe(400);
    expect((await call('GET', `/v1/onboarding/suggested-follows?concepts=urn:example:${randomUUID()}`)).status).toBe(400);
  } finally { await home.stop(); }
}, 300_000);
