import { useEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { LiteraryWorkIdentity } from './model';

const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function LiteraryReader({
  identity,
  locale,
  editionHref,
  factsHref,
  retired = false,
}: {
  identity: LiteraryWorkIdentity;
  locale: string;
  editionHref?: string | undefined;
  factsHref?: string | undefined;
  retired?: boolean;
}) {
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const heldFocus = typeof document !== 'undefined' && !!section.current?.contains(document.activeElement);

  useEffect(() => {
    if (retired && heldFocus) heading.current?.focus();
  }, [heldFocus, retired]);

  const options = { locale: locale as never };
  const title = identity.title.text || m.subject_value_unlabelled({}, options);

  return (
    <section
      ref={section}
      data-slot="literary-reader"
      aria-labelledby="literary-reader-title"
      className="min-w-0 space-y-4 rounded-lg border border-border p-4 sm:p-6"
    >
      <div className="space-y-2">
        <h2
          ref={heading}
          id="literary-reader-title"
          tabIndex={-1}
          lang={identity.title.lang}
          className="text-xl leading-snug font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-2xl"
        >
          {m.literary_reader_title({}, options)}
        </h2>
        {retired ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.literary_reader_stale({}, options)}
          </p>
        ) : (
          <>
            <p className="max-w-prose text-sm text-muted-foreground">{m.literary_reader_scope({}, options)}</p>
            <p lang={identity.title.lang} className="font-medium [overflow-wrap:anywhere]">
              {title}
            </p>
            {identity.titles.length > 1 && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{m.literary_reader_titles({}, options)}</h3>
                <ul className="grid min-w-0 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {identity.titles.map(({ language, text }) => (
                    <li key={`${language}:${text}`} lang={language} className="[overflow-wrap:anywhere]">
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {identity.aliases.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{m.literary_reader_aliases({}, options)}</h3>
                <ul className="grid min-w-0 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {identity.aliases.map(({ language, text }) => (
                    <li key={`${language}:${text}`} lang={language} className="[overflow-wrap:anywhere]">
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {identity.descriptions.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{m.literary_reader_descriptions({}, options)}</h3>
                <ul className="space-y-2">
                  {identity.descriptions.map(({ language, text }) => (
                    <li key={`${language}:${text}`} lang={language} className="max-w-prose [overflow-wrap:anywhere]">
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="max-w-prose text-sm text-muted-foreground">{m.literary_reader_return({}, options)}</p>
            <nav aria-label={m.literary_reader_title({}, options)} className="flex flex-wrap gap-x-5 gap-y-1">
              {editionHref ? (
                <a className={linkClass} href={editionHref}>
                  {m.literary_reader_editions({}, options)}
                </a>
              ) : null}
              {factsHref ? (
                <a className={linkClass} href={factsHref}>
                  {m.literary_reader_facts({}, options)}
                </a>
              ) : null}
            </nav>
          </>
        )}
      </div>
    </section>
  );
}
