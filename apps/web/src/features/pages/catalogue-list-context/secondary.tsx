import type { ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { listKeyFacts } from '../../../media/type-presentation';
import type { RowValue } from '../overview';
import type { LinkProps } from '../shared';
import { relationTargetHref } from '../edition-work';
import { catalogueText, type CatalogueContext } from './model';

/** Keep the original tab's native scope, opaque cursor, focus and scroll window available on return. */
export function CatalogueTargetLink({ children, locale, ...props }: LinkProps & { locale?: string }) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only">
        {' '}
        — {m.catalogue_context_new_tab({}, locale ? { locale: locale as never } : undefined)}
      </span>
    </a>
  );
}

export function CatalogueSecondary({
  context,
  value,
  nativeFacts,
}: {
  context: CatalogueContext;
  value: RowValue;
  nativeFacts: ReactNode;
}) {
  const o = { locale: value.locale as never };
  const text = (labels: Record<string, string>) => {
    const picked = pickText(labels, value.locale);
    return <span lang={picked.lang || undefined}>{catalogueText(picked.text)}</span>;
  };
  const source = (item: { label: Record<string, string>; observation: string }) => (
    <span data-source-observation={item.observation}> ({text(item.label)})</span>
  );
  const target = context.target && relationTargetHref({ id: context.subject, label: '' }, value.locale, value.context);
  const status =
    context.state === 'unknown'
      ? m.catalogue_context_unknown({}, o)
      : context.state === 'withheld'
        ? m.catalogue_context_withheld({}, o)
        : context.state === 'absent'
          ? m.catalogue_context_absent({}, o)
          : m.catalogue_context_unavailable({}, o);
  return (
    <div
      data-slot="catalogue-context"
      data-state={context.state}
      data-observation={context.observation}
      className="space-y-1 whitespace-normal [overflow-wrap:anywhere]"
    >
      {context.state !== 'ready' ? (
        <>
          {nativeFacts}
          <p>{status}</p>
        </>
      ) : (
        <>
          <p>{text(context.medium)}</p>
          {context.creators.map((creator, index) => {
            const name = pickText(creator.name, value.locale);
            const href =
              creator.target &&
              relationTargetHref({ id: creator.target.id, label: name.text }, value.locale, value.context);
            return (
              <p key={index} data-property={creator.property}>
                {text(creator.role)}:{' '}
                {href ? (
                  <CatalogueTargetLink
                    href={href}
                    lang={name.lang || undefined}
                    locale={value.locale}
                    className="inline-flex min-h-11 items-center rounded-sm underline underline-offset-4"
                  >
                    {catalogueText(name.text)}
                  </CatalogueTargetLink>
                ) : (
                  text(creator.name)
                )}
                {creator.qualifiers.map((qualifier, index) => (
                  <span key={index}>
                    {' '}
                    · {text(qualifier.label)}: {text(qualifier.value)}
                  </span>
                ))}
                {source(creator.source)}
              </p>
            );
          })}
          {context.facts.map((fact, index) => {
            const formatted = listKeyFacts({ [fact.property]: [fact.value] }, [fact.property], [], value.locale)[0];
            return formatted ? (
              <p key={index} data-property={fact.property}>
                {text(fact.label)}: <span lang={formatted.lang}>{catalogueText(formatted.text)}</span>
                {source(fact.source)}
              </p>
            ) : null;
          })}
          {context.statistic && (
            <p data-slot="provider-statistic">
              {text(context.statistic.measure)}: {new Intl.NumberFormat(value.locale).format(context.statistic.value)}
              {context.statistic.scale && (
                <span>
                  {' '}
                  ({context.statistic.scale.min}–{context.statistic.scale.max})
                </span>
              )}
              {context.statistic.count !== null && (
                <span>
                  {' '}
                  ·{' '}
                  {m.catalogue_context_observations(
                    {
                      count: new Intl.NumberFormat(value.locale).format(context.statistic.count),
                    },
                    o,
                  )}
                </span>
              )}
              {source(context.statistic.source)}
            </p>
          )}
          {context.more && target && (
            <CatalogueTargetLink
              href={target}
              locale={value.locale}
              className="inline-flex min-h-11 items-center rounded-sm underline underline-offset-4"
            >
              {m.library_more({}, o)}
            </CatalogueTargetLink>
          )}
        </>
      )}
    </div>
  );
}
