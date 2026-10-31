import { Cover, type CoverProps } from '@rezics/ui/cover';
import type { ReactNode } from 'react';
import { relationTargetHref } from './edition-work';
import type { RowValue } from './overview';
import type { QualifiedNote } from './qualified-relations';
import { LanguageTag } from './values';

/** A wrapping current credit beside its subject cover; shadcn has no qualified-credit presentation. */
export function QualifiedCredit({
  title,
  titleLang,
  href,
  cover,
  notes,
  qualified,
  value,
}: {
  title: string;
  titleLang?: string | undefined;
  href: string;
  cover: Omit<CoverProps, 'size'>;
  notes: readonly ReactNode[];
  qualified: readonly QualifiedNote[];
  value: RowValue;
}) {
  return (
    <div className="flex min-w-0 items-start gap-4">
      <div
        className={
          cover.listPresentation?.imageAspect === 'landscape' ? 'w-32 shrink-0 sm:w-48' : 'w-[72px] shrink-0 sm:w-24'
        }
      >
        <Cover {...cover} size="fill" decorative {...(value.ratio ? { ratio: value.ratio } : {})} />
      </div>
      <div className="min-w-0 flex-1 space-y-2 wrap-anywhere">
        <value.link
          href={href}
          lang={titleLang}
          className="text-base leading-snug font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {title}
        </value.link>
        <ul className="space-y-1 text-sm leading-6">
          {notes.map((note, index) => (
            <li key={`note-${index}`}>{note}</li>
          ))}
          {qualified.map((note, index) => (
            <li key={`qualified-${index}`}>
              {note.subject ? (
                <value.link
                  href={relationTargetHref(note.subject, value.locale, value.context)}
                  lang={note.language}
                  className="text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {note.text}
                </value.link>
              ) : (
                <span lang={note.language}>{note.text}</span>
              )}
              {note.language && (
                <>
                  {' '}
                  <LanguageTag lang={note.language} locale={value.locale} />
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
