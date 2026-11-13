import { useEffect, useRef, useState, type ReactNode } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { LiteraryWorkIdentity } from './model';
import type { LiteraryView } from './presentation';
import { HostedBookSubjectReaderLink } from '../../../books/reader/route';
import { BookShelfLink } from '../../../books/catalogue/shelf-link';
import { literaryStyle as style } from './style';

function LiteraryNames({ identity, locale }: { identity: LiteraryWorkIdentity; locale: string }) {
  const o = { locale: locale as never };
  const otherTitles = identity.titles.filter(
    ({ text, language }) => text !== identity.title.text || language !== identity.title.lang,
  );
  if (!otherTitles.length && !identity.aliases.length) return null;
  return (
    <details className="min-w-0">
      <summary className={style.disclosure}>{m.literary_reader_aliases({}, o)}</summary>
      <div className="grid gap-4 py-2 sm:grid-cols-2">
        {[
          { title: m.literary_reader_titles({}, o), names: otherTitles },
          { title: m.literary_reader_aliases({}, o), names: identity.aliases },
        ]
          .filter(({ names }) => names.length)
          .map(({ title, names }) => (
            <div key={title} className="min-w-0 space-y-2">
              <h3 className="text-sm text-muted-foreground">{title}</h3>
              <ul className="space-y-1">
                {names.map(({ language, text }) => (
                  <li key={`${language}:${text}`} lang={language} className="[overflow-wrap:anywhere]">
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </details>
  );
}

function LiteraryDescription({ identity, locale }: { identity: LiteraryWorkIdentity; locale: string }) {
  const o = { locale: locale as never };
  const primary = identity.descriptions.find(({ language }) => language === locale) ?? identity.descriptions[0];
  if (!primary) return null;
  const expanded = primary.text.length > 420 || identity.descriptions.length > 1;
  return (
    <div className="max-w-prose space-y-2 leading-relaxed [overflow-wrap:anywhere]">
      {expanded ? (
        <details className="group">
          <summary className={`${style.disclosure} list-none`}>
            <span lang={primary.language} className="block whitespace-pre-line font-normal group-open:hidden">
              {primary.text.length > 420 ? `${primary.text.slice(0, 420).trimEnd()}…` : primary.text}
            </span>
            <span className="mt-2 inline-block text-primary underline underline-offset-4 group-open:hidden">
              {m.literary_reader_read_more({}, o)}
            </span>
            <span className="hidden text-primary underline underline-offset-4 group-open:inline">
              {m.literary_reader_show_less({}, o)}
            </span>
          </summary>
          <div className="space-y-4 pb-2">
            {identity.descriptions.map(({ language, text }) => (
              <p key={`${language}:${text}`} lang={language} className="whitespace-pre-line">
                {text}
              </p>
            ))}
          </div>
        </details>
      ) : (
        <p lang={primary.language}>{primary.text}</p>
      )}
    </div>
  );
}

export function LiteraryReader({
  identity,
  locale,
  editionHref,
  factsHref,
  sourcesHref,
  shelfType,
  retired: sourceRetired = false,
  grainLabel,
  scopeText,
  recoveryHref,
  view = 'overview',
  composed = false,
  children,
}: {
  identity: LiteraryWorkIdentity;
  locale: string;
  editionHref?: string | undefined;
  factsHref?: string | undefined;
  sourcesHref?: string | undefined;
  shelfType?: string | undefined;
  retired?: boolean;
  grainLabel?: ReactNode;
  scopeText?: string;
  recoveryHref?: string;
  view?: LiteraryView;
  composed?: boolean;
  children?: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [departed, setDeparted] = useState(false);
  const retired = sourceRetired || departed;
  const heldFocus = typeof document !== 'undefined' && !!section.current?.contains(document.activeElement);
  useEffect(() => {
    if (retired && heldFocus) heading.current?.focus();
  }, [heldFocus, retired]);
  useEffect(() => {
    const leave = () => setDeparted(true);
    const restore = () => {
      if (document.activeElement !== document.body) return;
      const target = opener.current;
      if (target) (target.isConnected && !sourceRetired && !departed ? target : heading.current)?.focus();
    };
    const moved = (event: FocusEvent) => {
      // Choosing any other control cancels the saved opener, including a control inside this reader.
      if (event.target !== opener.current) opener.current = null;
    };
    document.addEventListener('focusin', moved);
    window.addEventListener('pagehide', leave);
    window.addEventListener('focus', restore);
    return () => {
      document.removeEventListener('focusin', moved);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('focus', restore);
    };
  }, [sourceRetired, departed]);
  const o = { locale: locale as never };
  const title = identity.title.text || m.subject_value_unlabelled({}, o);
  const headingText = retired
    ? m.literary_reader_title({}, o)
    : view === 'contents'
      ? m.subject_contents({}, o)
      : view === 'editions'
        ? m.subject_editions({}, o)
        : title;
  return (
    <section
      id="literary-reader"
      ref={section}
      data-slot="literary-reader"
      aria-labelledby="literary-reader-title"
      className={style.section}
      onClickCapture={(event) => {
        const link = (event.target as Element).closest('a[target="_blank"]');
        if (link instanceof HTMLElement) opener.current = link;
      }}
    >
      <header className="space-y-3">
        <h2
          ref={heading}
          id="literary-reader-title"
          tabIndex={-1}
          lang={view === 'overview' && !retired ? identity.title.lang : undefined}
          className={style.heading}
        >
          {headingText}
        </h2>
        {retired ? (
          <p role="status" className={style.muted}>
            {m.literary_reader_stale({}, o)}
            {recoveryHref && (
              <a className={style.link} href={recoveryHref}>
                {m.subject_relation_restart({}, o)}
              </a>
            )}
          </p>
        ) : (
          <>
            {!composed && view !== 'overview' && (
              <p lang={identity.title.lang} className="[overflow-wrap:anywhere]">
                {title}
              </p>
            )}
            {!composed && grainLabel}
            {view === 'overview' && !composed && (
              <>
                <LiteraryDescription identity={identity} locale={locale} />
                <LiteraryNames identity={identity} locale={locale} />
              </>
            )}
            {view !== 'overview' && <p className={style.muted}>{m.literary_reader_detail_hint({}, o)}</p>}
          </>
        )}
      </header>
      {!retired && (
        <>
          {identity.limited && (
            <p role="status" className={style.muted}>
              {m.literary_grain_terms_more({}, o)}
            </p>
          )}
          {children}
          <footer className={style.separator}>
            <nav aria-label={m.literary_reader_title({}, o)} className="flex flex-wrap gap-x-6 gap-y-1">
              <HostedBookSubjectReaderLink subjectId={identity.id} locale={locale} />
              {shelfType && <BookShelfLink locale={locale} type={shelfType} />}
              {editionHref && view !== 'editions' && (
                <a className={style.link} href={editionHref}>
                  {m.literary_reader_editions({}, o)}
                </a>
              )}
              {factsHref && (
                <a className={style.link} href={factsHref}>
                  {m.literary_reader_facts({}, o)}
                </a>
              )}
              {sourcesHref && (
                <a className={style.link} href={sourcesHref}>
                  {m.subject_sources({}, o)}
                </a>
              )}
            </nav>
            <details>
              <summary className={style.disclosure}>{m.literary_reader_about_reading({}, o)}</summary>
              <p className={style.muted}>{scopeText ?? m.literary_reader_scope({}, o)}</p>
              <p className={style.muted}>{m.literary_reader_return({}, o)}</p>
            </details>
          </footer>
        </>
      )}
    </section>
  );
}
