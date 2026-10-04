import {
  canonicalLanguage,
  direction,
  parseLanguage,
  selectDisplayName,
} from '../display-language/select.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import {
  readQuestionPresentationCurrent,
  type QuestionPresentationRead,
} from './question-presentation.ts';
import { QUESTION_PRESENTATION_COST } from './question-presentation-schema.ts';
import { readAuthoredRatingQuestion } from './question-presentation-context.ts';

interface AuthoredQuestion {
  context: string;
  question: string;
  language: string;
}
type Candidate = Pick<QuestionPresentationRead, 'component' | 'revision' | 'state'>;

/** The common selector decides language and script; this adapter exposes its
 * actual choice instead of relabeling a fallback as the reader's language. */
export function selectQuestionPresentation(
  authored: AuthoredQuestion,
  rows: readonly Candidate[],
  languages: readonly string[],
) {
  const original = canonicalLanguage(authored.language);
  if (!original) throw new RevisionCorrupt('Authored rating question language is invalid');
  const requested = [
    ...new Set(languages.flatMap((value) => canonicalLanguage(value) ?? [])),
  ].slice(0, QUESTION_PRESENTATION_COST.languagesPerRequest);
  const candidates = [...rows].sort((a, b) => a.state.language.localeCompare(b.state.language));
  const labels: Record<string, string> = { [original]: 'authored' };
  for (const row of candidates) {
    if (row.state.context !== authored.context || Object.hasOwn(labels, row.state.language)) {
      throw new RevisionCorrupt('Rating question presentation dimensions are ambiguous');
    }
    labels[row.state.language] = row.component;
  }
  const choice = selectDisplayName({ original, labels }, requested)!;
  const selected =
    choice.value === 'authored' ? null : candidates.find((row) => row.component === choice.value)!;
  const usedLanguage = selected?.state.language ?? original,
    value = selected?.state.question ?? authored.question;
  const requestedScript = requested[0] ? (parseLanguage(requested[0])?.script ?? null) : null;
  const usedScript = parseLanguage(usedLanguage)?.script ?? null;
  const crossedScript = !!requestedScript && !!usedScript && requestedScript !== usedScript;
  return {
    value,
    language: usedLanguage,
    direction: direction(usedLanguage, value),
    basis: choice.basis,
    script: usedScript,
    reviewStatus: selected?.state.reviewStatus ?? ('authored' as const),
    presentation: selected ? { component: selected.component, revision: selected.revision } : null,
    source: selected?.state.source ?? null,
    licence: selected?.state.licence ?? null,
    fallback:
      requested[0] === usedLanguage
        ? null
        : {
            reason: crossedScript ? ('script-fallback' as const) : ('language-fallback' as const),
            requestedLanguages: requested,
            usedLanguage,
            requestedScript,
            usedScript,
            crossedScript,
            conversion: null,
          },
  };
}

/** O(L) metadata for this Context only, then three exact graph reads and one
 * immutable object for its selected language. No fixed prefix of languages. */
export async function readDisplayRatingQuestion(
  env: WorkActivationEnvironment,
  authored: AuthoredQuestion,
  languages: readonly string[],
) {
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?presentation ?head ?language WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?presentation a rv:RatingQuestionPresentation ;
      rv:presentationContext ${iri(authored.context)} ; rv:questionPresentationHead ?head ; rv:presentationLanguage ?language .
      FILTER NOT EXISTS { ?presentation rv:protectionHead ?protection } }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RatingQuestionPresentationRevision, rv:RevisionAnchor ;
      rv:component ?presentation ; rv:presentationContext ${iri(authored.context)} ;
      rv:presentationLanguage ?language ; rv:reviewStatus rv:Reviewed ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } }
  }`)
    ).results?.bindings ?? [];
  const index = rows.map((row) => {
    if (
      !row.presentation ||
      !row.head ||
      !row.language ||
      canonicalLanguage(row.language.value) !== row.language.value
    ) {
      throw new RevisionCorrupt('Rating question presentation index is invalid');
    }
    return {
      component: row.presentation.value,
      revision: row.head.value,
      state: {
        context: authored.context,
        language: row.language.value,
        question: '',
        reviewStatus: 'reviewed' as const,
        source: '',
        licence: '',
      },
    };
  });
  const choice = selectQuestionPresentation(authored, index, languages);
  if (!choice.presentation) return choice;
  const selected = await readQuestionPresentationCurrent(env, choice.presentation.component);
  if (
    !selected ||
    selected.revision !== choice.presentation.revision ||
    selected.state.context !== authored.context ||
    selected.state.language !== choice.language ||
    selected.state.reviewStatus !== 'reviewed'
  ) {
    throw new RevisionCorrupt(
      'Selected rating question presentation moved or differs from its index',
    );
  }
  // Keep all candidate dimensions for the same selection decision; only the
  // selected row's immutable object needs to be resolved.
  return selectQuestionPresentation(
    authored,
    index.map((row) => (row.component === selected.component ? selected : row)),
    languages,
  );
}

export async function presentRatingQuestions<T extends AuthoredQuestion>(
  env: WorkActivationEnvironment,
  items: readonly T[],
  languages: readonly string[],
) {
  if (items.length > QUESTION_PRESENTATION_COST.contextBatch)
    throw new RevisionCorrupt('Rating question batch exceeds its read bound');
  const result = [];
  for (const item of items)
    result.push({
      ...item,
      displayQuestion: await readDisplayRatingQuestion(env, item, languages),
    });
  return result;
}

export async function presentRatingContext<T extends { context: string; question: string }>(
  env: WorkActivationEnvironment,
  context: T,
  languages: readonly string[],
) {
  const authored = await readAuthoredRatingQuestion(env, context.context);
  if (authored.question !== context.question)
    throw new RevisionCorrupt('Authored question moved during its Context read');
  return {
    ...context,
    language: authored.language,
    displayQuestion: await readDisplayRatingQuestion(env, authored, languages),
  };
}
