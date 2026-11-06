import { m } from '../paraglide/messages.js';
import { displayRating, QUESTION } from '../features/pages/subject-ratings';
import type { CollectionViewerFacts } from './reads';

export type LibraryScoreQuestion = {
  id: string;
  meaning: string | null;
  revision: number;
  grain: string;
  minimumUnits: number;
  maximumUnits: number;
  stepUnits: number;
  lifecycleState: string;
  lifecycleRevision: number;
};

export type LibraryViewerFacts = CollectionViewerFacts;

const displayScale = (question: LibraryScoreQuestion | { scale: { min: number; max: number; displayStep: number } }) =>
  'scale' in question
    ? question.scale
    : { min: question.minimumUnits, max: question.maximumUnits, displayStep: question.stepUnits };

export function formatOwnScore(units: number, question: Parameters<typeof displayScale>[0], locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    displayRating(units, displayScale(question)),
  );
}

export function ownScoreUnits(input: {
  subjectId: string;
  rowKey?: string;
  personalScore?: number | null;
  scoreQuestion?: LibraryScoreQuestion | null;
  viewerFacts?: LibraryViewerFacts;
}):
  | {
      units: number | null;
      question: LibraryScoreQuestion | NonNullable<Extract<LibraryViewerFacts, { state: 'current' }>['question']>;
    }
  | undefined {
  if (input.scoreQuestion && input.scoreQuestion.id === QUESTION && input.personalScore !== undefined)
    return { units: input.personalScore, question: input.scoreQuestion };
  if (!input.viewerFacts || input.viewerFacts.state !== 'current' || !input.viewerFacts.question) return undefined;
  const question = input.viewerFacts.question;
  const matches = input.viewerFacts.rows.filter(
    (row) => row.subjectId === input.subjectId && (input.rowKey === undefined || row.rowKey === input.rowKey),
  );
  if (matches.length !== 1) return undefined;
  const vote = matches[0]!.vote;
  if (vote.state === 'unavailable') return undefined;
  if (vote.state === 'absent') return { units: null, question };
  return { units: vote.units, question };
}

export function LibraryOwnScore({
  subjectId,
  rowKey,
  personalScore,
  scoreQuestion,
  viewerFacts,
  locale,
}: {
  subjectId: string;
  rowKey?: string;
  personalScore?: number | null;
  scoreQuestion?: LibraryScoreQuestion | null;
  viewerFacts?: LibraryViewerFacts;
  locale: string;
}) {
  const own = ownScoreUnits({
    subjectId,
    ...(rowKey === undefined ? {} : { rowKey }),
    ...(personalScore === undefined ? {} : { personalScore }),
    ...(scoreQuestion === undefined ? {} : { scoreQuestion }),
    ...(viewerFacts === undefined ? {} : { viewerFacts }),
  });
  if (!own) return null;
  const meaning = own.question.meaning;
  const title = meaning?.trim() ? meaning : undefined;
  return (
    <p className="text-sm text-muted-foreground" data-library-own-score="" title={title}>
      {title ? <span className="sr-only">{title}: </span> : null}
      {own.units === null
        ? m.subject_rating_control_unrated({}, { locale: locale as never })
        : m.subject_ratings_yours(
            { score: formatOwnScore(own.units, own.question, locale) },
            { locale: locale as never },
          )}
    </p>
  );
}
