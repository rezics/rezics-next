import { m } from '../paraglide/messages.js';
import { formatOwnScore, ownScoreUnits, type LibraryScoreQuestion, type LibraryViewerFacts } from './score';

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
  const own = ownScoreUnits({ subjectId, rowKey, personalScore, scoreQuestion, viewerFacts });
  if (!own) return null;
  const meaning = 'meaning' in own.question ? own.question.meaning : own.question.meaning;
  const title = meaning?.trim() ? meaning : undefined;
  return (
    <p className="text-sm text-muted-foreground" data-library-own-score="" title={title}>
      {title ? <span className="sr-only">{title}: </span> : null}
      {own.units === null
        ? m.subject_rating_control_unrated({}, { locale: locale as never })
        : m.subject_ratings_yours({ score: formatOwnScore(own.units, own.question, locale) }, { locale: locale as never })}
    </p>
  );
}
