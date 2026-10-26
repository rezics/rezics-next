import { Cover, sharedRatio } from '@rezics/ui/cover';
import { Link } from '@tanstack/react-router';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectTitle, type ThreadSubject } from './subjects';

/** The subjects a thread is attached to, each as its cover frame and title linked to its page. */
export function ThreadSubjects({ subjects }: { subjects: readonly ThreadSubject[] }) {
  if (subjects.length === 0) return null;
  const locale = getLocale();
  const titled = subjects.map((subject) => ({
    ...subject,
    title: subjectTitle(subject, locale) ?? m.threads_untitled(),
  }));
  const ratio = sharedRatio(titled);
  const labels = {
    withheld: m.thread_cover_withheld(),
    reveal: m.thread_cover_reveal(),
    credit: m.thread_cover_credit(),
    via: m.thread_cover_via(),
  };
  return (
    <ul aria-label={m.thread_subjects_heading()} className="flex flex-wrap gap-3">
      {titled.map((subject) => (
        <li
          key={subject.id}
          className="flex min-w-0 max-w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-2 pe-4"
        >
          <Cover
            cover={subject.cover}
            decorative
            labels={labels}
            ratio={ratio}
            size="sm"
            src={coverSrc}
            subject={subject}
          />
          <Link
            to="/subjects/$id"
            params={{ id: subject.id }}
            className="min-w-0 font-medium break-words underline-offset-4 hover:underline"
          >
            {subject.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
