import { Cover, sharedRatio } from '@rezics/ui/cover';
import { ContentItem } from '@rezics/ui/content-item';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectTitle, type ThreadSubject } from './subjects';
import { subjectHref } from '../subject/subject-href';

/** The subjects a thread is attached to, each as its cover frame and title linked to its page. */
export function ThreadSubjects({ subjects }: { subjects: readonly ThreadSubject[] }) {
  if (subjects.length === 0) return null;
  const locale = getLocale();
  const titled = subjects.map((subject) => {
    const title = subjectTitle(subject, locale) ?? m.threads_untitled();
    return { ...subject, title, href: subjectHref({ id: subject.id, label: title }, locale) };
  });
  const ratio = sharedRatio(titled);
  const labels = {
    withheld: m.thread_cover_withheld(),
    reveal: m.thread_cover_reveal(),
    credit: m.thread_cover_credit(),
    via: m.thread_cover_via(),
  };
  const list = (
    <ul aria-label={m.thread_subjects_heading()} className="grid min-w-0 max-w-full gap-x-4 sm:grid-cols-2">
      {titled.map((subject) => (
        <ContentItem
          key={subject.id}
          title={subject.title}
          href={subject.href.href}
          headingLevel={2}
          className="min-h-14 max-w-full items-center py-2 sm:py-2 [overflow-wrap:anywhere] [&_[data-content-item-slot=title]]:line-clamp-none"
          visual={
            <Cover
              cover={subject.cover}
              decorative
              labels={labels}
              ratio={ratio}
              size="xs"
              src={coverSrc}
              subject={subject}
            />
          }
        />
      ))}
    </ul>
  );
  return titled.length <= 4 ? (
    list
  ) : (
    <details className="min-w-0 rounded-lg border border-border px-3">
      <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-ring">
        {m.thread_subjects_heading()} ({titled.length})
      </summary>
      {list}
    </details>
  );
}
