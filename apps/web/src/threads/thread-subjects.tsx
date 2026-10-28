import { Cover, sharedRatio } from '@rezics/ui/cover';
import { Link } from '@tanstack/react-router';
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
  return (
    <ul aria-label={m.thread_subjects_heading()} className="flex min-w-0 max-w-full gap-2 overflow-x-auto">
      {titled.map((subject) => (
        <li
          key={subject.id}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-card p-1 pe-2 text-sm"
        >
          <Cover
            cover={subject.cover}
            decorative
            labels={labels}
            ratio={ratio}
            size="xs"
            src={coverSrc}
            subject={subject}
          />
          <Link
            to={subject.href.to}
            params={subject.href.params}
            className="min-w-0 font-medium break-words underline-offset-4 hover:underline"
          >
            {subject.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
