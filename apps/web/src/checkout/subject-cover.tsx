import { Cover, type CoverSize, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { coverSrc } from '../media/cover-src';
import { subjectHref } from '../subject/subject-href';
import { pageText } from '../features/pages/shared';

/** The subject summary the kernel returns with an offer or an order, or null when the reader cannot see the subject. */
export type SubjectSummary = {
  id: string;
  types: readonly string[];
  label: { value: string; language: string } | null;
  cover: CoverSummary | null;
} | null;

export type SubjectCoverData = { subject: CoverSubject; cover: CoverSummary | null; href: string | null };

/** What the cover of a sold subject needs. A subject nobody can see still gets its frame, titled by the offer. */
export function subjectCover(
  locale: string,
  targetSubjectId: string,
  fallbackTitle: string,
  summary: SubjectSummary,
): SubjectCoverData {
  const id = summary?.id ?? targetSubjectId;
  const title = summary?.label
    ? pageText({ [summary.label.language]: summary.label.value }, locale, summary.label.language).text || fallbackTitle
    : fallbackTitle;
  return {
    subject: { id, title, types: summary?.types ?? [] },
    cover: summary?.cover ?? null,
    href: summary ? subjectHref({ id, label: title }, locale).href : null,
  };
}

/** The sold subject's cover, a link to its page when there is one. */
export function SubjectCover({
  data,
  size,
  priority = false,
}: {
  data: SubjectCoverData;
  size: CoverSize;
  priority?: boolean;
}) {
  const { subject, cover, href } = data;
  const drawn = (
    <Cover subject={subject} cover={cover} size={size} src={coverSrc} priority={priority} decorative={href !== null} />
  );
  if (href === null) return drawn;
  return (
    <a
      href={href}
      aria-label={subject.title}
      className="block max-w-full shrink-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {drawn}
    </a>
  );
}
