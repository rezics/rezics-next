import { canonicalLanguage, selectDisplayName } from '../display-language/select.ts';
import {
  readCurrentOccurrence,
  readExactDefinition,
  readExactOccurrence,
  type ExactDefinition,
} from '../relation/change.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable } from '../semantic/command.ts';
import type { ReferenceCheck } from '../semantic/read.ts';
import type { SemanticValue } from '../semantic/value.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { readPresentationCurrent, type PresentationRead } from './change.ts';
import type { PresentationState } from './schema.ts';

export interface RelationBinding {
  role: string;
  participant: SemanticValue | { kind: 'unavailable-reference' };
  position?: number;
}
export type RelationRenderSubject =
  | { definition: string; revision?: string }
  | { occurrence: string; revision?: string }
  | {
      meaning: ExactDefinition;
      bindings: RelationBinding[];
      occurrence?: string;
      revision?: string;
    };
export interface FallbackProvenance {
  reason: 'language-fallback' | 'script-fallback' | 'missing-direction';
  requestedLanguages: string[];
  usedLanguage: string | null;
  requestedScript: string | null;
  usedScript: string | null;
  crossedScript: boolean;
  conversion: null;
}
export interface RelationProjection {
  fromRole: string;
  toRole: string;
  presentation: { component: string; revision: string } | null;
  labels: Pick<PresentationState, 'noun' | 'heading' | 'plurals' | 'grammaticalForms'> | null;
  language: string | null;
  script: string | null;
  direction: 'ltr' | 'rtl' | null;
  reviewStatus: PresentationState['reviewStatus'] | null;
  source: string | null;
  licence: string | null;
  fallback: FallbackProvenance | null;
  arguments: {
    role: string;
    type: SemanticValue['kind'] | 'unavailable-reference';
    value: RelationBinding['participant'];
    position?: number;
  }[];
}
export interface RelationRendering {
  profile: 'relation-rendering-v1';
  meaning: {
    definition: string;
    revision: string;
    lifecycle: string;
    roles: (ExactDefinition['roles'][number] & { key: string })[];
  };
  occurrence: { component: string; revision: string } | null;
  viewingRole: string;
  bindings: RelationBinding[];
  projections: RelationProjection[];
}

export function languageScript(language: string): string | null {
  try {
    return new Intl.Locale(language).maximize().script ?? null;
  } catch {
    return null;
  }
}

/**
 * Language choice belongs to display-language/select.ts. This adapter records the
 * actual result, including a script crossing even if that selector calls it requested.
 * RFC 4647 lookup alone does not promise script preservation:
 * https://www.rfc-editor.org/rfc/rfc4647#section-3.4
 */
export function selectedProjection(
  rows: readonly PresentationRead[],
  fromRole: string,
  toRole: string,
  languages: readonly string[],
  bindings: readonly RelationBinding[],
): RelationProjection {
  const preferences = languages.flatMap((value) => {
    const language = canonicalLanguage(value);
    return language ? [language] : [];
  });
  const candidates = rows
    .filter((row) => row.state.fromRole === fromRole && row.state.toRole === toRole)
    .sort((a, b) => a.state.language.localeCompare(b.state.language));
  const selected = selectDisplayName(
    new Map(candidates.map((row) => [row.state.language, row.component])),
    preferences,
  );
  const row = selected ? candidates.find((row) => row.component === selected.value)! : null;
  const usedScript = row ? languageScript(row.state.language) : null;
  const requested = preferences[0] ?? null;
  const requestedScript = requested ? languageScript(requested) : null;
  const crossedScript = !!requestedScript && !!usedScript && requestedScript !== usedScript;
  const exact = !!row && preferences[0] === row.state.language;
  const fallback: FallbackProvenance | null = exact
    ? null
    : {
        reason: !row
          ? 'missing-direction'
          : crossedScript
            ? 'script-fallback'
            : 'language-fallback',
        requestedLanguages: preferences,
        usedLanguage: row?.state.language ?? null,
        requestedScript,
        usedScript,
        crossedScript,
        conversion: null,
      };
  return {
    fromRole,
    toRole,
    presentation: row ? { component: row.component, revision: row.revision } : null,
    labels: row
      ? {
          noun: row.state.noun,
          heading: row.state.heading,
          plurals: row.state.plurals,
          grammaticalForms: row.state.grammaticalForms,
        }
      : null,
    language: row?.state.language ?? null,
    script: usedScript,
    direction: selected?.direction ?? null,
    reviewStatus: row?.state.reviewStatus ?? null,
    source: row?.state.source ?? null,
    licence: row?.state.licence ?? null,
    fallback,
    arguments: bindings
      .filter((item) => item.role === fromRole || item.role === toRole)
      .map((item) => ({
        role: item.role,
        type: item.participant.kind,
        value: item.participant,
        ...(item.position === undefined ? {} : { position: item.position }),
      })),
  };
}

/** Select across the whole language inventory; request batch size never becomes a stored-language cap. */
interface PresentationIndex {
  component: string;
  revision: string;
  language: string;
  fromRole: string;
  toRole: string;
}
async function presentations(
  env: WorkActivationEnvironment,
  meaning: ExactDefinition,
): Promise<PresentationIndex[]> {
  const result = await env.fuseki
    .query(`PREFIX rv: <${RV}> SELECT ?presentation ?head ?language ?from ?to WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?presentation a rv:DefinitionPresentation ;
      rv:presentationDefinition ${iri(meaning.definition)} ; rv:meaningRevision ${iri(meaning.revision)} ;
      rv:presentationHead ?head ; rv:presentationLanguage ?language ; rv:fromRole ?from ; rv:toRole ?to } }`);
  // Read the immutable objects only for selected languages, independently for each direction.
  const rows = result.results?.bindings ?? [];
  const tuples = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.language!.value, row.from!.value, row.to!.value]);
    if (tuples.has(key)) throw new RevisionCorrupt('presentation language direction is ambiguous');
    tuples.add(key);
  }
  // Returned here as metadata, resolved below after the shared selector chooses a language.
  return rows.map((row) => ({
    component: row.presentation!.value,
    revision: row.head!.value,
    language: row.language!.value,
    fromRole: row.from!.value,
    toRole: row.to!.value,
  }));
}

/**
 * A kind resolves its current meaning; an occurrence retains its exact meaning.
 * Authorized G-831 reads can pass their resolved meaning and redacted bindings.
 * Cost: indexed meaning/occurrence lookups, O(language rows for this meaning),
 * at most 15 selected object reads and 64 bindings; no unrelated Resource scan.
 */
export async function renderRelation(
  env: WorkActivationEnvironment,
  subject: RelationRenderSubject,
  viewingRole: string,
  languages: readonly string[],
  canRead: ReferenceCheck,
): Promise<RelationRendering> {
  let meaning: ExactDefinition | null;
  let bindings: RelationBinding[] = [];
  let occurrence: RelationRendering['occurrence'] = null;
  if ('meaning' in subject) {
    meaning = subject.meaning;
    bindings = subject.bindings;
    occurrence =
      subject.occurrence && subject.revision
        ? { component: subject.occurrence, revision: subject.revision }
        : null;
  } else if ('definition' in subject) {
    if (!(await canRead(subject.definition)))
      throw new SemanticTargetUnavailable('relation definition is unavailable');
    const revision =
      subject.revision ?? (await readCurrentComponent(env, subject.definition, 'definition'))?.head;
    meaning = revision ? await readExactDefinition(env, revision) : null;
    if (meaning && meaning.definition !== subject.definition) meaning = null;
  } else {
    if (!(await canRead(subject.occurrence)))
      throw new SemanticTargetUnavailable('relation occurrence is unavailable');
    const revision =
      subject.revision ?? (await readCurrentOccurrence(env, subject.occurrence))?.head;
    const read = revision ? await readExactOccurrence(env, subject.occurrence, revision) : null;
    meaning = read ? await readExactDefinition(env, read.state.definition) : null;
    if (read && meaning) {
      occurrence = { component: subject.occurrence, revision: read.revision };
      for (const item of read.state.participations)
        bindings.push({
          role: meaning.roleKeys[item.role]!,
          participant:
            item.participant.kind === 'resource' && !(await canRead(item.participant.ref))
              ? { kind: 'unavailable-reference' }
              : item.participant,
          ...(item.position === undefined ? {} : { position: item.position }),
        });
    }
  }
  if (!meaning) throw new SemanticTargetUnavailable('relation meaning is unavailable');
  if (!Object.values(meaning.roleKeys).includes(viewingRole))
    throw new SemanticChangeRejected('invalid', 'viewing role is unknown');
  const rows = await presentations(env, meaning);
  const projections: RelationProjection[] = [];
  for (const toRole of Object.values(meaning.roleKeys).filter((key) => key !== viewingRole)) {
    const candidates = rows
      .filter((row) => row.fromRole === viewingRole && row.toRole === toRole)
      .sort((a, b) => a.language.localeCompare(b.language));
    const choice = selectDisplayName(
      new Map(candidates.map((row) => [row.language, row.component])),
      languages,
    );
    const index = choice ? candidates.find((row) => row.component === choice.value)! : null;
    if (index) {
      const selected = await readPresentationCurrent(env, index.component);
      if (
        !selected ||
        selected.revision !== index.revision ||
        selected.state.meaningRevision !== meaning.revision ||
        selected.state.definition !== meaning.definition ||
        selected.state.fromRole !== viewingRole ||
        selected.state.toRole !== toRole ||
        selected.state.language !== index.language
      ) {
        throw new RevisionCorrupt('selected presentation changed or differs from its dimensions');
      }
      projections.push(selectedProjection([selected], viewingRole, toRole, languages, bindings));
    } else projections.push(selectedProjection([], viewingRole, toRole, languages, bindings));
  }
  return {
    profile: 'relation-rendering-v1',
    meaning: {
      definition: meaning.definition,
      revision: meaning.revision,
      lifecycle: meaning.lifecycle,
      roles: meaning.roles.map((role) => ({ ...role, key: meaning.roleKeys[role.role]! })),
    },
    occurrence,
    viewingRole,
    bindings,
    projections,
  };
}
