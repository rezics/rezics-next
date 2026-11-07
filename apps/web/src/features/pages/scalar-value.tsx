import type { ReactNode } from 'react';
import type { StatementReadingValueProps } from '../catalogue/statement-reading';
import { m } from '../../paraglide/messages.js';
import { LANGUAGE_PROPERTY, languageName } from '../../subject/language';
import { quantityPresentation } from '../../subject/quantity-presentation';
import { timePresentation } from '../../subject/reader';
import { subjectHref } from '../../subject/subject-href';
import { statementDocument } from './documents';
import { DocumentValue } from './values';
import { ExternalValue, isRecord, linkClass, linkColor, pageText, PlainLink, type PageLink, type Snak } from './shared';

export type ScalarValueOptions = {
  locale: string;
  messages: { unknown: string; none: string; unlabelled: string };
  link: PageLink;
};
export const TAG_PROPERTIES = ['schema:keywords', 'schema:genre'] as const;
export const TAG_PROPERTY_SET = new Set<string>(TAG_PROPERTIES);

export function itemLink(id: string, labels: unknown, options: ScalarValueOptions) {
  const label = pageText(labels, options.locale);
  const Link = options.link;
  return (
    <span className={`${linkClass} ${label.text ? linkColor : 'text-muted-foreground'}`}>
      <Link
        href={subjectHref({ id, label: label.text || options.messages.unlabelled }, options.locale).href}
        {...(label.lang ? { lang: label.lang } : {})}
      >
        {label.text || options.messages.unlabelled}
      </Link>
    </span>
  );
}

export function timeText(value: unknown, locale: string): string {
  return timePresentation(value, locale).text;
}

export function inlineValue(
  snak: Snak,
  related: StatementReadingValueProps['related'],
  options: ScalarValueOptions,
): ReactNode {
  const { value, property } = snak;
  if (value.type === 'somevalue' || value.type === 'novalue') {
    return (
      <span className="text-muted-foreground">
        {value.type === 'somevalue' ? options.messages.unknown : options.messages.none}
      </span>
    );
  }
  if (value.type !== 'value') return null;
  const content = value.content;
  if (property.data_type === 'wikibase-item' && typeof content === 'string') {
    const entry = Object.hasOwn(related, content) ? related[content] : undefined;
    if (TAG_PROPERTY_SET.has(property.id)) {
      const label = pageText(entry?.labels, options.locale);
      if (!entry || !label.text) return null;
    }
    return itemLink(entry?.redirect ?? content, entry?.labels, options);
  }
  if (property.data_type === 'quantity') {
    const quantity = quantityPresentation(content, related, options.locale);
    if (!quantity) return null;
    const unit = quantity.unitLabel ?? m.quantity_unit_unavailable({}, { locale: options.locale as never });
    return (
      <span>
        {quantity.numbers}
        {unit ? ` ${unit}` : ''}
      </span>
    );
  }
  if (property.data_type === 'time') return <span>{timeText(content, options.locale)}</span>;
  if (property.data_type === 'monolingualtext' && isRecord(content) && typeof content.language === 'string') {
    const text = pageText({ [content.language]: content.text }, options.locale);
    return <span lang={text.lang}>{text.text}</span>;
  }
  if (typeof content !== 'string' || content === '') return null;
  // A media id or a document is shown by the statement's own view; as a qualifier it has no reading form.
  if (property.data_type === 'media') return null;
  if (property.id === LANGUAGE_PROPERTY) {
    const name = languageName(content, options.locale);
    return name === undefined ? null : <span>{name}</span>;
  }
  return property.data_type === 'url' ? <ExternalValue value={content} /> : <span>{content}</span>;
}

/** Reuse ordinary field rendering in the private candidate comparison, without exposing raw JSON or ids. */
export function CandidateValue({
  snak,
  related,
  locale,
  subject,
  documents,
  documentUnavailable,
  link = PlainLink,
}: {
  snak: Snak & { id?: string };
  related: StatementReadingValueProps['related'];
  locale: string;
  subject?: string;
  /** Authorized responses from this comparison's current read, never draft envelopes or a shared cache. */
  documents?: unknown;
  /** Profile readers can name an unavailable authored field without treating it like an ordinary scalar. */
  documentUnavailable?: ReactNode;
  link?: PageLink;
}) {
  const messages = {
    unknown: m.subject_value_unknown({}, { locale: locale as never }),
    none: m.subject_value_none({}, { locale: locale as never }),
    unlabelled: m.subject_value_unlabelled({}, { locale: locale as never }),
    sources: '',
    aliases: '',
    search: '',
  };
  const content = snak.value.type === 'value' ? snak.value.content : undefined;
  if (snak.value.type === 'somevalue' || snak.value.type === 'novalue')
    return (
      <span className="text-muted-foreground">
        {snak.value.type === 'somevalue' ? messages.unknown : messages.none}
      </span>
    );
  if (snak.value.type === 'value' && snak.property.data_type === 'document') {
    const document = statementDocument(subject ?? '', snak, documents);
    if (document && isRecord(content))
      return (
        <DocumentValue
          document={document}
          lang={typeof content.language === 'string' ? content.language : undefined}
          locale={locale}
          labels={{
            documentSpoiler: m.thread_reveal_spoiler({}, { locale: locale as never }),
            spoilerShow: '',
            cover: { withheld: '', reveal: '', credit: '', via: '' },
          }}
        />
      );
    return documentUnavailable ?? <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  }
  if (snak.property.data_type === 'media')
    return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  if (snak.property.data_type === 'quantity') {
    const quantity = quantityPresentation(content, related, locale);
    if (!quantity) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
    const unit = quantity.unitLabel ?? m.quantity_unit_unavailable({}, { locale: locale as never });
    return (
      <span>
        {quantity.numbers}
        {unit ? ` ${unit}` : ''}
      </span>
    );
  }
  return (
    inlineValue(snak, related, {
      locale,
      messages,
      link,
    }) ?? <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>
  );
}
