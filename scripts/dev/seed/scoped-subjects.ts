import { createHash } from 'node:crypto';
import { SeedApiError } from './api.ts';
import { catalogueWorkBody } from '../../../tests/fixtures/catalogue/intake.ts';
import { relationLexiconSeed, CANONICITY_PROPERTY, type LexiconSeedDefinition } from './relation-lexicon-data.ts';
import { seedRelationLexicon, seedVariantKindConcepts, seedCanonicity } from './relation-lexicon.ts';
import { seedScopedSubjectQuestions, scopedSubjectLocales, type ScopedSubjectApi, type GlobalQuestions } from './scoped-subjects-questions.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/target-context-authority.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import type { ReleaseV2Write } from '../../../services/main/src/modules/release/schema.ts';

const RV = 'https://rezics.com/vocab/';
const short = (ref: string) => ref.slice(-36);
const resource = (ref: string) => ({ kind: 'resource' as const, ref });
const text = (lexical: string) => ({ kind: 'literal' as const, lexical,
  datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString', language: 'en' });
export interface ScopedSubjectRater { actor: string; api: ScopedSubjectApi }
export interface ScopedSubjectPort {
  api: ScopedSubjectApi;
  actor: string;
  namespace: string;
  /** Fixture authority setup; every catalogue, vocabulary, fact and rating
   * write below is a normal public command. Production bootstrap uses no grants. */
  authorize(scope: string, action: string, actor?: string): Promise<void>;
  raters: readonly ScopedSubjectRater[];
  /** A definition key already registered in this project. The acceptance fixture
   * resolves it from shared object bytes; the dev seed uses the public read. */
  findDefinition?(key: string): Promise<Written | null>;
}
interface Work { work: string; mainVersion: string; mainRevision: string; workRevision: string }
interface Written { component: string; revision: string }
interface Occurrence { occurrence: string; revision: string }
export interface ScopedSubjectManifest {
  profile: 'scoped-subjects-seed-v2';
  questions: GlobalQuestions;
  works: Record<string, Work>;
  subjects: Record<string, string>;
  positions: Record<string, { structure: string; occurrence: string; work: string }>;
  projections: Record<string, string>;
  relations: Record<string, Occurrence>;
  statements: Record<string, string>;
  definitions: Record<string, string>;
  release: string;
  authority: string;
  variantKind: string;
  itemQuestion: string;
}

export function scopedSubjectId(namespace: string, name: string): string {
  const hex = createHash('sha256').update(`scoped-subjects-v2:${namespace}:${name}`).digest('hex').slice(0, 32);
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** One bounded demo, replayable under a retained namespace. Fifty distinct
 * principals are the smallest population that can qualify one ranking entry.
 * Work, episode/route positions and projection identities are separate records. */
export async function loadScopedSubjects(port: ScopedSubjectPort): Promise<ScopedSubjectManifest> {
  if (port.raters.length < 50) throw new Error('Scoped subjects need 50 distinct raters for the ranking');
  if (new Set(port.raters.map(rater => rater.actor)).size !== port.raters.length)
    throw new Error('Scoped subject raters must use distinct Agents and principals');
  const { api, actor, namespace } = port;
  // Earlier seeds pinned different predicate meanings and group coordinates.
  // Keep their receipts immutable; this version is independently replayable.
  const key = (name: string) => `${namespace}:scoped:v2:${name}`;
  const authorize = (scope: string, action: string, on = actor) => port.authorize(scope, action, on);
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'], ['work:create:root', 'work.create'],
    ['catalogue:verify:root', 'catalogue.verify'], ['relation:create:root', 'relation.change'],
    ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'],
    [GLOBAL_TARGET_CONTEXT_SCOPE, 'rating.context.create'],
  ]) await authorize(scope!, action!);
  const questions = await seedScopedSubjectQuestions({ get: path => api.get(path), post: async <T>(path: string, body: object, requestKey: string) => {
    if (path === '/v1/rating-question-presentations') {
      await authorize(`rating:presentation:${(body as { state: { context: string } }).state.context}`,
        'rating.question-presentation.review');
    }
    return api.post<T>(path, body, requestKey);
  } }, actor, namespace);
  const result: ScopedSubjectManifest = { profile: 'scoped-subjects-seed-v2', questions,
    works: {}, subjects: {}, positions: {}, projections: {}, relations: {}, statements: {}, definitions: {},
    release: '', authority: '', variantKind: '', itemQuestion: '' };
  const primaryWorks = new Map<string, string>();
  // Catalogue intake retains the candidate receipt across retries; it does not
  // claim that these existing published Works are the fixture author's own work.
  for (const [id, title, type] of [
    ['index', 'A Certain Magical Index', 'https://schema.org/TVSeries'],
    ['railgun', 'A Certain Scientific Railgun', 'https://schema.org/TVSeries'],
    ['fate-vn', 'Fate/stay night', 'https://schema.org/VideoGame'],
    ['blue-archive', 'Blue Archive', 'https://schema.org/VideoGame'],
    ['dragon-ball', 'Dragon Ball', 'https://schema.org/TVSeries'],
    ['dragon-ball-z', 'Dragon Ball Z', 'https://schema.org/TVSeries'],
    ['conan', 'Detective Conan', 'https://schema.org/TVSeries'],
    ['fate-zero', 'Fate/Zero', 'https://schema.org/TVSeries'],
    ['canon', 'Star Wars: The Force Awakens', 'https://schema.org/Movie'],
    ['legends', 'Heir to the Empire', 'https://schema.org/Book'],
    ['match', 'Harbor Invitational — exhibition match broadcast', 'https://schema.org/VideoObject'],
    ['railgun-episode-3', 'A Certain Scientific Railgun — Season 1, episode 3', 'https://schema.org/VideoObject'],
    ['railgun-episode-4', 'A Certain Scientific Railgun — Season 1, episode 4', 'https://schema.org/VideoObject'],
    ['fate-zero-episode-24', 'Fate/Zero — Episode 24', 'https://schema.org/VideoObject'],
    ['heavens-feel-route', "Fate/stay night — Heaven's Feel route", 'https://schema.org/DigitalDocument'],
  ]) {
    const body = await catalogueWorkBody({ actingSubject: actor,
      request: async (method, path, body, requestKey) => ({ status: 200, body: method === 'GET'
        ? await api.get(path) : await api.post(path, body as object, requestKey ?? key(`intake:${id}`)) }) },
    { title: `${title}${namespace.startsWith('demo') ? '' : ` [${namespace}]`}`, language: 'en', semanticTypes: [type!] }, key(`work:${id}`));
    const work = await api.post<Work>('/v1/works', body, key(`work:${id}`));
    result.works[id!] = work;
    await authorize(`work:read:${work.work}`, 'work.read');
    await authorize(`work:edit:${work.work}`, 'work.edit');
  }
  const semantic = async (id: string, name: string, type: string, work: string, extra: object[] = []) => {
    const saved = await api.post<Written>('/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: actor,
      state: { component: 'resource', types: [type], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
        // The owner uses this pointer for Work-scoped admission and disclosure.
        { predicate: `${RV}semanticWork`, value: resource(work) }, ...extra,
      ] },
    }, key(`resource:${id}`));
    result.subjects[id] = saved.component;
    primaryWorks.set(id, work);
    return saved.component;
  };
  for (const [id, name, type, work] of [
    ['misaka', 'Misaka Mikoto', `${RV}Character`, 'railgun'],
    ['artoria', 'Artoria Pendragon', `${RV}Character`, 'fate-vn'],
    ['alter', 'Saber Alter', `${RV}Character`, 'fate-vn'],
    ['saber-title', 'Saber', `${RV}Title`, 'fate-vn'],
    ['hoshino', 'Takanashi Hoshino', `${RV}Character`, 'blue-archive'],
    ['swimsuit', 'Hoshino (Swimsuit)', `${RV}GameUnit`, 'blue-archive'],
    ['goku', 'Son Goku', `${RV}Character`, 'dragon-ball'],
    ['conan', 'Edogawa Conan', `${RV}Character`, 'conan'],
    ['player', 'Alex Chen — Harbor Invitational player', 'https://schema.org/Person', 'match'],
    ['match', 'Harbor Invitational exhibition match', 'https://schema.org/Event', 'match'],
    ['map-a', 'Harbor Invitational — Haven', 'https://schema.org/Event', 'match'],
    ['map-b', 'Harbor Invitational — Ascent', 'https://schema.org/Event', 'match'],
    ['excalibur', 'Excalibur', 'https://schema.org/Thing', 'fate-zero'],
    ['anakin', 'Anakin Skywalker', `${RV}Character`, 'canon'],
    ['canon', 'Star Wars Canon', `${RV}NarrativeContinuity`, 'canon'],
    ['legends', 'Star Wars Legends', `${RV}NarrativeContinuity`, 'legends'],
    ['lead', 'Lead character', `${RV}Role`, 'railgun'],
    ['support', 'Supporting character', `${RV}Role`, 'index'],
    ['opponent', 'Opponent', `${RV}Role`, 'fate-vn'],
  ]) await semantic(id!, name!, type!, result.works[work!]!.work,
    id === 'conan' ? [{ predicate: 'https://schema.org/alternateName',
      value: { kind: 'language-string', lexical: 'Kudo Shinichi', language: 'en' } }] : []);
  // Episodes and routes are Works placed as parts of their series or game,
  // using the same reading-order placements as published narrative parts.
  for (const [id, workKey, part, label] of [
    ['railgun-episode', 'railgun', 'railgun-episode-3', 'Season 1, episode 3'],
    ['heavens-feel', 'fate-vn', 'heavens-feel-route', "Heaven's Feel route"],
    ['fate-zero-episode', 'fate-zero', 'fate-zero-episode-24', 'Episode 24'],
  ]) {
    const work = result.works[workKey!]!;
    const base = await api.post<{ structure: string; revision: string }>('/v1/compositions', {
      profile: 'work-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: actor,
    }, key(`structure:${id}`));
    const changed = await api.post<{ occurrences: string[] }>(`/v1/compositions/${short(base.structure)}/changes`, {
      profile: 'work-composition', expectedHead: base.revision, actingSubject: actor,
      operations: [{ op: 'insert', parent: base.structure, position: 'last', role: 'part', target: result.works[part!]!.work,
        label: { value: label, language: 'en' }, displayLabel: label, inclusion: 'required' }],
    }, key(`position:${id}`));
    result.positions[id!] = { structure: base.structure, occurrence: changed.occurrences[0]!, work: work.work };
    await authorize(`semantic:read:${changed.occurrences[0]!}`, 'semantic.read');
  }
  const definitions = new Map<string, Written>();
  const currentDefinition = async (notation: string) => {
    try {
      const saved = await api.get<{ definition: string; revision: string }>(
        `/v1/lexicon/definitions/${notation}?actingSubject=${encodeURIComponent(actor)}`);
      return { component: saved.definition, revision: saved.revision };
    } catch (error) { if (error instanceof SeedApiError && error.status === 404) return null; throw error; }
  };
  const lexicon = {
    post: <T>(path: string, body: object, requestKey: string) => api.post<T>(path, body, requestKey),
    authorizeDefinition: async (saved: Written) => {
      await authorize(`semantic:read:${saved.component}`, 'semantic.read');
      await authorize(`semantic:edit:${saved.component}`, 'lexicon.presentation.change');
    },
  };
  const variants = await seedVariantKindConcepts(lexicon, actor, namespace);
  // These four keys are canonical across a project. Reuse a registered key and
  // install only a missing one, without pinning this namespace's Concepts as
  // the only admitted kind members.
  const identityLinkKeys = new Set(['variant-of', 'holds-title', 'represents', 'in-continuity']);
  const missing: LexiconSeedDefinition[] = [];
  for (const spec of relationLexiconSeed) {
    if (!identityLinkKeys.has(spec.key)) continue;
    const current = port.findDefinition ? await port.findDefinition(spec.key) : await currentDefinition(spec.key);
    if (!current) { missing.push(spec); continue; }
    await authorize(`semantic:read:${current.component}`, 'semantic.read');
    definitions.set(spec.key, current);
  }
  for (const saved of missing.length ? await seedRelationLexicon(lexicon, actor, namespace, missing) : []) {
    definitions.set(saved.key, saved);
  }
  let appearance = await currentDefinition('appearance');
  appearance ??= await api.post<Written>('/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: actor,
    state: { component: 'definition', kind: 'relation', notation: 'appearance', workSubjectRole: 'work',
      roles: ['subject', 'work', 'role'].map(role => ({ key: role, minParticipants: 1, maxParticipants: 1, ordered: false })) },
  }, key('definition:appearance'));
  await authorize(`semantic:read:${appearance.component}`, 'semantic.read');
  definitions.set('appearance', appearance);
  for (const [name, definition] of definitions) result.definitions[name] = definition.component;
  const labelDefinition = async (definition: Written, fromRole: string, toRole: string, labels: readonly string[], name: string) => {
    await authorize(`semantic:edit:${definition.component}`, 'lexicon.presentation.review');
    for (const [index, language] of scopedSubjectLocales.entries()) {
      const current = await api.get<{ items: { renderings: { projections: { fromRole: string; toRole: string; language: string | null; labels: unknown }[] }[] }[] }>(
        `/v1/lexicon/presentations?definitions=${encodeURIComponent(definition.component)}&languages=${language}&actingSubject=${encodeURIComponent(actor)}`);
      if (current.items.some(item => item.renderings.some(rendering => rendering.projections.some(projection =>
        projection.fromRole === fromRole && projection.toRole === toRole && projection.language === language && projection.labels)))) continue;
      const noun = labels[index]!;
      await api.post('/v1/lexicon/presentations', { profile: 'definition-presentation-v1', expectedHead: null, actingSubject: actor,
        state: { definition: definition.component, meaningRevision: definition.revision, fromRole, toRole, language,
          noun, heading: noun, plurals: { other: noun }, grammaticalForms: [],
          source: 'https://rezics.com/definition/scoped-subjects-seed-v2',
          licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'reviewed' } }, key(`label:${name}:${language}`));
    }
  };
  await labelDefinition(appearance, 'subject', 'work', ['Appears in', '登場作品', '登场作品', '登場作品', '등장 작품', 'Auftritte in', 'Apparaît dans', 'Aparece en'], 'appearance-work');
  await labelDefinition(appearance, 'work', 'subject', ['Characters', '角色', '角色', 'キャラクター', '캐릭터', 'Figuren', 'Personnages', 'Personajes'], 'appearance-subject');
  await labelDefinition(appearance, 'subject', 'role', ['Role', '角色定位', '角色定位', '役割', '역할', 'Rolle', 'Rôle', 'Papel'], 'appearance-role');
  await labelDefinition(appearance, 'work', 'role', ['Role', '角色定位', '角色定位', '役割', '역할', 'Rolle', 'Rôle', 'Papel'], 'appearance-work-role');
  await labelDefinition(appearance, 'role', 'subject', ['Characters', '角色', '角色', 'キャラクター', '캐릭터', 'Figuren', 'Personnages', 'Personajes'], 'appearance-role-subject');
  await labelDefinition(appearance, 'role', 'work', ['Appears in', '登場作品', '登场作品', '登場作品', '등장 작품', 'Auftritte in', 'Apparaît dans', 'Aparece en'], 'appearance-role-work');
  const subjectWork = await api.post<Written>('/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: actor,
    state: { component: 'definition', kind: 'relation', workSubjectRole: 'work',
      roles: ['subject', 'work'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
  }, key('definition:subject-work'));
  await authorize(`semantic:read:${subjectWork.component}`, 'semantic.read');
  await labelDefinition(subjectWork, 'subject', 'work', ['Work', '作品', '作品', '作品', '작품', 'Werk', 'Œuvre', 'Obra'], 'subject-work');
  await labelDefinition(subjectWork, 'work', 'subject', ['Subjects', '主體', '主体', '対象', '대상', 'Gegenstände', 'Sujets', 'Sujetos'], 'work-subject');
  definitions.set('subject-work', subjectWork);
  result.definitions['subject-work'] = subjectWork.component;
  for (const concept of Object.values(variants)) await authorize(`semantic:read:${concept}`, 'semantic.read');
  result.variantKind = variants.persona;
  const vocabulary = await seedCanonicity({ ...lexicon, post: async <T>(path: string, body: object, requestKey: string) => {
    if (path === '/v1/semantic/changes' && 'state' in body && (body.state as { notation?: string }).notation === 'canonicity') {
      // This copy pins its own property revision and Concept scheme. The
      // project-wide canonicity key remains the production bootstrap's meaning.
      const { notation: _notation, ...state } = body.state as Record<string, unknown>;
      return api.post<T>(path, { ...body, state }, requestKey);
    }
    return api.post<T>(path, body, requestKey);
  } }, actor, namespace);
  for (const concept of Object.values(vocabulary.concepts)) await authorize(`semantic:read:${concept}`, 'semantic.read');
  const relation = async (id: string, definition: string, bindings: { role: string; ref: string; creditedName?: string }[],
    applicability: string[] = []) => {
    const saved = await api.post<Occurrence>('/v1/relations/changes', {
      profile: 'relation-change-v1', expectedHead: null, definition: definitions.get(definition)!.revision,
      participations: bindings.map(binding => ({ role: binding.role, participant: resource(binding.ref),
        ...(binding.creditedName ? { creditedName: { lexical: binding.creditedName, language: 'en' } } : {}) })),
      applicability, actingSubject: actor,
    }, key(`relation:${id}`));
    await authorize(`semantic:read:${saved.occurrence}`, 'semantic.read');
    result.relations[id] = saved;
  };
  const subject = (id: string) => result.subjects[id]!;
  // The public membership has labels; the owner pointer above retains its
  // admission/disclosure meaning. Appearances retain their separate roles.
  for (const [id, work] of primaryWorks) await relation(`work:${id}`, 'subject-work',
    [{ role: 'subject', ref: subject(id) }, { role: 'work', ref: work }]);
  const appear = (id: string, on: string, work: string, role: string, frames: string[] = [], credit?: string) =>
    relation(id, 'appearance', [{ role: 'subject', ref: subject(on), ...(credit ? { creditedName: credit } : {}) },
      { role: 'work', ref: result.works[work]!.work }, { role: 'role', ref: subject(role) }], frames);
  await appear('misaka-index', 'misaka', 'index', 'support');
  await appear('misaka-railgun', 'misaka', 'railgun', 'lead');
  await appear('alter-route', 'alter', 'fate-vn', 'opponent', [result.positions['heavens-feel']!.occurrence], 'Saber');
  await appear('conan-credit', 'conan', 'conan', 'lead', [], 'Kudo Shinichi');
  await relation('alter-variant', 'variant-of', [{ role: 'variant', ref: subject('alter') },
    { role: 'hub', ref: subject('artoria') }, { role: 'kind', ref: variants.persona }]);
  await relation('saber-title', 'holds-title', [{ role: 'holder', ref: subject('alter') }, { role: 'title', ref: subject('saber-title') }],
    [result.positions['heavens-feel']!.occurrence]);
  await relation('swimsuit-unit', 'represents', [{ role: 'unit', ref: subject('swimsuit') }, { role: 'character', ref: subject('hoshino') }]);
  for (const continuity of ['canon', 'legends']) await relation(`${continuity}-work`, 'in-continuity',
    [{ role: 'work', ref: result.works[continuity]!.work }, { role: 'continuity', ref: subject(continuity) }]);
  // Each predicate pins its own labelled meaning, as wiki claims do, rather
  // than borrowing one anonymous definition for unrelated assertions.
  const predicates = new Map<string, Written>();
  for (const [name, labels] of [
    ['ability', ['Ability', '能力', '能力', '能力', '능력', 'Fähigkeit', 'Capacité', 'Habilidad']],
    ['age', ['Age', '年齡', '年龄', '年齢', '나이', 'Alter', 'Âge', 'Edad']],
    ['form', ['Form', '形態', '形态', '形態', '형태', 'Form', 'Forme', 'Forma']],
    ['isPartOf', ['Part of', '所屬', '所属', '所属', '소속', 'Teil von', 'Fait partie de', 'Parte de']],
    ['participatesIn', ['Participates in', '參與', '参与', '参加', '참가', 'Teilnahme an', 'Participe à', 'Participa en']],
    ['family', ['Family', '家庭', '家庭', '家族', '가족', 'Familie', 'Famille', 'Familia']],
  ] as const) {
    const definition = await api.post<Written>('/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: actor,
      state: { component: 'definition', kind: 'relation', roles: ['subject', 'value'].map(key =>
        ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
    }, key(`definition:fact:${name}`));
    await authorize(`semantic:read:${definition.component}`, 'semantic.read');
    await labelDefinition(definition, 'subject', 'value', labels, `fact:${name}`);
    predicates.set(name, definition);
    result.definitions[name] = definition.component;
  }
  const statement = async (id: string, on: string, predicate: string, value: object, applicability: string[],
    evidence: string[] = [], speaker = actor, meaning?: string) => {
    const definition = predicates.get(predicate);
    await authorize(`statement:speak:${speaker}`, 'statement.record', speaker);
    const saved = await api.post<{ statement: string }>('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: on, predicate: definition?.component ?? predicate, relationDefinition: meaning ?? definition!.revision,
      value, applicability, interpretation: { kind: 'selected' }, evidence, actingSubject: speaker,
    }, key(`statement:${id}`));
    await api.post('/v1/statement-decisions', { profile: 'statement-decision-v1',
      target: { kind: 'statement', statement: saved.statement }, acceptance: { kind: 'global' },
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
    }, key(`accept:${id}`));
    result.statements[id] = saved.statement;
  };
  await statement('misaka-ability', subject('misaka'), 'ability', text('Electromaster'), [result.works.railgun!.work]);
  for (const [id, work, predicate, value] of [
    ['goku-child', 'dragon-ball', 'age', 'Child'], ['goku-adult', 'dragon-ball-z', 'age', 'Adult'],
    ['goku-base', 'dragon-ball', 'form', 'Base form'], ['goku-super-saiyan', 'dragon-ball-z', 'form', 'Super Saiyan'],
  ]) await statement(id!, subject('goku'), predicate!, text(value!), [result.works[work!]!.work],
    ['https://en.dragon-ball-official.com/news/01_3864.html']);
  await statement('map-in-match', subject('map-a'), 'isPartOf', { kind: 'resource', iri: subject('match') }, []);
  await statement('second-map-in-match', subject('map-b'), 'isPartOf', { kind: 'resource', iri: subject('match') }, []);
  await statement('player-in-match', subject('player'), 'participatesIn', { kind: 'resource', iri: subject('match') }, []);
  await statement('canon-family', subject('anakin'), 'family', text('Grandfather of Ben Solo'), [subject('canon')],
    ['https://www.starwars.com/news/darth-vader-kylo-ren-grandfather-grandson']);
  await statement('legends-family', subject('anakin'), 'family', text('Father of Luke Skywalker'), [subject('legends')],
    ['https://www.starwars.com/databank/luke-skywalker']);
  const authority = await api.post<{ agent: string }>('/v1/agents', { profile: 'agent-provision-v1', kind: 'organization',
    displayName: 'Continuity authority (demo curator)' }, key('authority'));
  result.authority = authority.agent;
  for (const continuity of ['canon', 'legends']) await statement(`canonicity-${continuity}`, result.works[continuity]!.work,
    CANONICITY_PROPERTY, { kind: 'resource', iri: vocabulary.concepts[continuity as 'canon' | 'legends'] },
    [subject(continuity)], ['https://www.starwars.com/news/the-legendary-star-wars-expanded-universe-turns-a-new-page'],
    authority.agent, vocabulary.definition.revision);
  const game = result.works['blue-archive']!;
  const realizationId = scopedSubjectId(namespace, 'blue-archive-original');
  const realization = await api.put<{ revision: string }>(`/v1/works/${short(game.work)}/realizations/${short(realizationId)}`, {
    profile: 'realization-v1', id: realizationId, expectedHead: null, kind: 'original', language: 'ja', status: 'official',
    verification: 'unverified', evidence: 'https://bluearchive.jp/', source: { kind: 'main-version', work: game.work,
      mainVersion: game.mainVersion, revision: game.mainRevision }, translators: [], publishers: [], actingSubject: actor,
  } satisfies RealizationWrite, key('realization:game'));
  result.release = scopedSubjectId(namespace, 'blue-archive-version');
  await api.put(`/v1/works/${short(game.work)}/releases/${short(result.release)}`, {
    profile: 'release-v2', id: result.release, expectedHead: null, actingSubject: actor, kind: 'formal', status: 'official',
    titleLanguage: 'en', tracklistLanguage: null, title: { value: 'Blue Archive — demo summer balance snapshot', language: 'en' },
    editionStatement: null, publisher: null, publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null,
    identifiers: [{ provider: 'https://rezics.com/demo/game-versions', value: 'summer-balance' }], platform: 'Mobile', territory: null,
    coverage: [{ realization: realizationId, revision: realization.revision, completeness: 'complete' }], evidence: null,
  } satisfies ReleaseV2Write, key('release:game'));
  for (const [id, on, frames] of [
    ['misaka-episode', subject('misaka'), [result.positions['railgun-episode']!.occurrence]],
    ['alter-route', subject('alter'), [result.positions['heavens-feel']!.occurrence]],
    ['swimsuit-version', subject('swimsuit'), [result.release]],
    ['player-map-a', subject('player'), [subject('map-a')]], ['player-map-b', subject('player'), [subject('map-b')]],
    ['excalibur-episode', subject('excalibur'), [result.positions['fate-zero-episode']!.occurrence]],
    ['anakin-canon', subject('anakin'), [subject('canon')]],
  ] as const) {
    const saved = await api.post<{ projection: { id: string } }>('/v1/projections', {
      subject: on, frames: [...frames], actingSubject: actor,
    }, key(`projection:${id}`));
    result.projections[id] = saved.projection.id;
  }
  // Items have their own question; an item must never enter a Character or unit question.
  const itemQuestion = await api.post<{ context: string }>('/v1/rating-contexts', {
    profile: 'realm-target-rating-context-v4', realm: 'https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c',
    question: 'How effective was this item here?', language: 'en', targetGrain: 'projection',
    acceptedSubjectTypes: ['https://schema.org/Thing'], acceptedFrameDimensions: ['position'], actingSubject: actor,
  }, key('item-question'));
  result.itemQuestion = itemQuestion.context;
  for (const [target, context, count, values] of [
    [subject('misaka'), questions.character.context, 5, [7, 8, 9, 8, 8]],
    [result.projections['misaka-episode']!, questions.performance.context, 10, [8]],
    [result.projections['swimsuit-version']!, questions.unit.context, 10, [9]],
    [result.projections['player-map-a']!, questions.performance.context, 50, [8, 10]],
    [result.projections['player-map-b']!, questions.performance.context, 9, [6]],
    [result.projections['excalibur-episode']!, itemQuestion.context, 5, [9]],
  ] as const) for (let index = 0; index < count; index++) {
    const rater = port.raters[index]!;
    await rater.api.post('/v1/rating-observations', {
      profile: 'realm-target-rating-observation-v1', context, target,
      expectedRevisionHead: null, value: values[index % values.length]!, actingSubject: rater.actor,
    }, key(`rating:${short(target)}:${index}`));
  }
  // Compute both metrics and the ranking through the API, never persist means.
  for (const formula of ['pooled', 'mean-of-means']) await api.post('/v1/rating-rollups', {
    profile: 'rating-rollup-v1', context: questions.performance.context,
    targets: [result.projections['player-map-a'], result.projections['player-map-b']], formula,
    rank: true, actingSubject: actor,
  }, key(`rollup:${formula}`));
  return result;
}
