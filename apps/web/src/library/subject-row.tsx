import { Cover, sharedRatio, type CoverRatio, type CoverSize, type CoverSubject } from '@rezics/ui/cover';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { subjectHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { LibrarySubject } from './reads';

/** What `Cover` needs of an embedded subject; a subject nobody can read still gets its frame, titled as unavailable. */
export function coverSubject(subject: LibrarySubject | null): CoverSubject {
  return subject
    ? { id: subject.id, title: subject.label, types: subject.types }
    : { id: 'unavailable', title: m.library_subject_unavailable(), types: [] };
}

/** One frame ratio for the subjects of a list, so a row of mixed types stays aligned; unreadable subjects do not vote. */
export function rowRatio(subjects: readonly (LibrarySubject | null)[]): CoverRatio {
  return sharedRatio(subjects.filter((subject) => subject !== null).map(coverSubject));
}

/** The cover of an embedded subject beside its visible title, so it is decorative. */
export function SubjectCover({
  subject,
  ratio,
  size = 'xs',
  className = '',
  priority = false,
}: {
  subject: LibrarySubject | null;
  ratio: CoverRatio;
  size?: CoverSize;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Cover
      subject={coverSubject(subject)}
      cover={subject?.cover ?? null}
      size={size}
      className={className}
      priority={priority}
      ratio={ratio}
      src={coverSrc}
      decorative
      labels={{
        withheld: m.thread_cover_withheld(),
        reveal: m.thread_cover_reveal(),
        credit: m.thread_cover_credit(),
        via: m.thread_cover_via(),
      }}
    />
  );
}

/**
 * The identity half of a library row: the subject's cover, its title linked to its page, its localized type and any
 * line of detail beside the type. A subject nobody can read shows the shared unavailable label and never its id.
 */
export function SubjectIdentity({
  subject,
  ratio,
  size = 'xs',
  children,
}: {
  subject: LibrarySubject | null;
  ratio: CoverRatio;
  size?: CoverSize;
  children?: ReactNode;
}) {
  const href = subject ? subjectHref({ id: subject.id, label: subject.label }, getLocale()) : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <SubjectCover subject={subject} ratio={ratio} size={size} />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium break-words">
          {subject ? (
            <Link to={href!.to} params={href!.params} className="text-primary underline-offset-4 hover:underline">
              {subject.label}
            </Link>
          ) : (
            <span>{m.library_subject_unavailable()}</span>
          )}
        </p>
        {subject?.typeLabel || children ? (
          <p className="text-sm text-muted-foreground">
            {subject?.typeLabel}
            {subject?.typeLabel && children ? ' · ' : null}
            {children}
          </p>
        ) : null}
      </div>
    </div>
  );
}
