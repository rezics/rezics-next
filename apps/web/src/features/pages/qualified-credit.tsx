import type { CoverProps } from '@rezics/ui/cover';
import { CoverCard } from '@rezics/ui/cover-card';
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
    <CoverCard
      title={title}
      {...(titleLang ? { titleLang } : {})}
      href={href}
      link={value.link}
      cover={{ ...cover, ...(value.ratio ? { ratio: value.ratio } : {}) }}
      essentialCredit={
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
      }
    />
  );
}
