import type { CoverProps } from '@rezics/ui/cover';
import { CoverCard } from '@rezics/ui/cover-card';
import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { relationTargetHref } from './edition-work';
import type { RowValue } from './overview';
import type { QualifiedNote } from './qualified-relations';
import { LanguageTag } from './values';
import type { LinkProps } from './shared';

function ExactEditionLink({ href, lang, className, children }: LinkProps) {
  return (
    <a href={href} lang={lang} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A wrapping current credit beside its subject cover; shadcn has no qualified-credit presentation. */
export function QualifiedCredit({
  title,
  titleLang,
  href,
  cover,
  notes,
  qualified,
  value,
  openInNewTab = false,
  inspection,
}: {
  title: string;
  titleLang?: string | undefined;
  href: string;
  cover: Omit<CoverProps, 'size'>;
  notes: readonly ReactNode[];
  qualified: readonly QualifiedNote[];
  value: RowValue;
  openInNewTab?: boolean;
  inspection?: ReactNode;
}) {
  return (
    <div className="min-w-0 [&_h3_a]:inline-block [&_h3_a]:min-h-11 [&_h3_a]:max-w-full [&_h3_a]:min-w-11 [&_h3_a]:whitespace-pre-wrap">
      <CoverCard
        title={title}
        {...(titleLang ? { titleLang } : {})}
        href={href}
        link={openInNewTab ? ExactEditionLink : value.link}
        cover={{ ...cover, ...(value.ratio ? { ratio: value.ratio } : {}) }}
        essentialCredit={
          <>
            {(notes.length > 0 || qualified.length > 0) && (
              <ul className="flex min-w-0 flex-col gap-1 whitespace-pre-wrap text-sm leading-6 wrap-anywhere">
                {notes.map((note, index) => (
                  <li key={`note-${index}`}>{note}</li>
                ))}
                {qualified.map((note, index) => {
                  const quantity = note.quantity?.presentation;
                  const unit = quantity
                    ? (quantity.unitLabel ?? m.quantity_unit_unavailable({}, { locale: value.locale as never }))
                    : '';
                  return (
                    <li
                      key={`qualified-${index}`}
                      data-property={note.property}
                      className={
                        note.property === 'wdt:P3831' ||
                        note.property === 'wdt:P453' ||
                        note.property === 'schema:character'
                          ? 'font-medium'
                          : undefined
                      }
                    >
                      {quantity ? (
                        <span>
                          {note.text} {quantity.numbers}
                          {unit ? ` ${unit}` : ''}
                        </span>
                      ) : note.subject ? (
                        <value.link
                          href={relationTargetHref(note.subject, value.locale, value.context)}
                          lang={note.language}
                          className="inline-block min-h-11 min-w-11 max-w-full py-2.5 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
                  );
                })}
              </ul>
            )}
            {inspection}
          </>
        }
      />
    </div>
  );
}
