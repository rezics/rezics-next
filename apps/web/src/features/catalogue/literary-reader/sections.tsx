import { m } from '../../../paraglide/messages.js';
import type { Related } from '../../../subject/types';
import { CandidateValue } from '../../pages/data';
import { ExactEditionLink } from '../../pages/cover-list';
import { pageText, type Snak, type PageLink } from '../../pages/shared';
import { LanguageTag } from '../../pages/values';
import type { LiteraryAssertion, LiteraryDefinitions, LiteraryState, LiteraryWindow } from './model';
import { literaryDestination } from './navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function LiteraryStatus({ state, locale }: { state: LiteraryState; locale: string }) {
  const o = { locale: locale as never };
  const text = {
    loading: () => m.subject_relation_loading({}, o),
    preparing: () => m.literary_grain_preparing({}, o),
    empty: () => m.literary_grain_empty({}, o),
    sparse: () => m.literary_grain_sparse({}, o),
    ready: () => m.literary_grain_window({}, o),
    withheld: () => m.literary_grain_withheld({}, o),
    unavailable: () => m.literary_grain_unavailable({}, o),
    unsupported: () => m.literary_grain_unsupported({}, o),
  }[state]();
  return (
    <p role="status" data-state={state} className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

function DisclosedValue({
  snak,
  related,
  locale,
  link,
}: {
  snak: Snak;
  related: Related;
  locale: string;
  link: PageLink;
}) {
  const target =
    snak.value.type === 'value' && snak.property.data_type === 'wikibase-item' ? snak.value.content : undefined;
  // A public id without this response's disclosed summary is never a navigation grant.
  if (typeof target === 'string' && !Object.hasOwn(related, target))
    return <span>{m.literary_grain_withheld({}, { locale: locale as never })}</span>;
  return <CandidateValue snak={snak} related={related} locale={locale} link={link} />;
}

/** Shared native value rendering preserves source strings, quantity datatypes and partial date precision. */
export function LiteraryAssertionView({
  assertion,
  definitions,
  locale,
  link,
  membership = false,
  showValue = true,
}: {
  assertion: LiteraryAssertion;
  definitions: LiteraryDefinitions;
  locale: string;
  link: PageLink;
  membership?: boolean;
  showValue?: boolean;
}) {
  const { statement, related } = assertion;
  const o = { locale: locale as never };
  const propertyLabel = (snak: Snak) => pageText(definitions.properties[snak.property.id]?.labels, locale);
  const part = (snak: Snak, index: number) => {
    const label = propertyLabel(snak);
    return (
      <li key={index} data-property={snak.property.id} className="[overflow-wrap:anywhere]">
        {label.text ? <span lang={label.lang}>{label.text}: </span> : null}
        <DisclosedValue snak={snak} related={related} locale={locale} link={link} />
      </li>
    );
  };
  return (
    <div data-statement-id={statement.id} className="min-w-0 space-y-2">
      {showValue && <DisclosedValue snak={statement} related={related} locale={locale} link={link} />}
      {statement.qualifiers.length > 0 && (
        <ul className="space-y-1 border-l border-border pl-3 text-sm">{statement.qualifiers.map(part)}</ul>
      )}
      {membership &&
        !statement.qualifiers.some((snak) => ['schema:position', 'wdt:P1545'].includes(snak.property.id)) && (
          <p className="text-sm text-muted-foreground">{m.literary_grain_position_unknown({}, o)}</p>
        )}
      {statement.references.length > 0 && (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2">{m.subject_sources({}, o)}</summary>
          <ol className="space-y-3">
            {statement.references.map((reference, index) => (
              <li key={index}>
                <ul className="space-y-1">{reference.parts.map(part)}</ul>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

export function LiteraryNativeWindow({
  window,
  definitions,
  locale,
  returnTo,
  realm,
  nextHref,
  restartHref,
}: {
  window: LiteraryWindow;
  definitions: LiteraryDefinitions;
  locale: string;
  returnTo: string;
  realm?: string | undefined;
  nextHref?: string | undefined;
  restartHref?: string | undefined;
}) {
  const { native, state } = window;
  const property = definitions.properties[native.property];
  const title = pageText(native.direction === 'inverse' ? property?.relation?.inverseLabels : property?.labels, locale);
  const o = { locale: locale as never };
  const Link: PageLink = ({ href, ...props }) => <ExactEditionLink href={href} {...props} />;
  return (
    <section
      data-slot="literary-window"
      data-node={native.node}
      data-direction={native.direction}
      className="min-w-0 space-y-3"
    >
      <h3 lang={title.lang} className="font-medium [overflow-wrap:anywhere]">
        {title.text || m.subject_relations({}, o)}
      </h3>
      <LiteraryStatus state={state} locale={locale} />
      {(state === 'ready' || state === 'preparing') && window.rows.length > 0 && (
        <ul className="divide-y divide-border">
          {window.rows.map((row) => {
            const type = pageText(definitions.types[row.type]?.labels, locale);
            const RowLink: PageLink = ({ href, ...props }) => (
              <Link href={withSubjectVisitReturn(href, returnTo, locale)} {...props} />
            );
            return (
              <li key={row.key} data-statement-id={row.statement.id} className="min-w-0 space-y-1 py-3">
                <ExactEditionLink
                  href={literaryDestination(row.id, row.label.text, locale, returnTo, realm)}
                  lang={row.label.lang}
                  className={action}
                >
                  {row.label.text || m.subject_value_unlabelled({}, o)}
                </ExactEditionLink>
                {type.text && (
                  <p lang={type.lang} className="text-sm text-muted-foreground">
                    {type.text}
                  </p>
                )}
                {row.label.lang && <LanguageTag lang={row.label.lang} locale={locale} />}
                <LiteraryAssertionView
                  assertion={row}
                  showValue={false}
                  definitions={definitions}
                  locale={locale}
                  link={RowLink}
                  membership={property?.relation?.group === 'membership'}
                />
              </li>
            );
          })}
        </ul>
      )}
      {state === 'ready' && window.withheld && <LiteraryStatus state="withheld" locale={locale} />}
      <nav className="flex flex-wrap gap-x-4">
        {nextHref &&
          native.status === 200 &&
          (state === 'ready' || state === 'sparse' || state === 'withheld' || state === 'preparing') && (
            <a href={nextHref} className={action}>
              {m.subject_section_more({ label: title.text }, o)}
            </a>
          )}
        {restartHref && state !== 'empty' && (
          <a href={restartHref} className={action}>
            {m.subject_relation_restart({}, o)}
          </a>
        )}
      </nav>
    </section>
  );
}
