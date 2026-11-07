import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { quantityPresentation } from '../../subject/quantity-presentation';
import { subjectHref } from '../../subject/load-subject';
import { m } from '../../paraglide/messages.js';

/** Layout token the work readers own; it matches the ordinary Subject section rhythm. */
export const workReadingSectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';

export type WorkReadingLink = ComponentType<{
  href: string;
  lang?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}>;

/** Disclosed related summaries the value renderer may label; it never hydrates a target. */
export type WorkReadingRelated = Record<string, { labels?: Record<string, string>; type?: string; redirect?: string }>;

/** One disclosed Snak. Readers pass the native statement or qualifier without copying it. */
export type WorkReadingSnak = {
  property: { id: string; data_type: string };
  value: { type: string; content?: unknown };
  id?: string;
};

export type WorkReadingValueProps = {
  snak: WorkReadingSnak;
  related: WorkReadingRelated;
  locale: string;
  link: WorkReadingLink;
};

/**
 * Consumer-owned reading port. Game edition/evidence and Manga evidence render values through
 * `renderValue`; page composition binds CandidateValue. Request/result vocabulary lives here.
 * Adapters and registration live at the composition root.
 */
export type WorkReadingPort = {
  readonly sectionClass: string;
  renderValue(props: WorkReadingValueProps): ReactNode;
};

export const WorkReadingContext = createContext<WorkReadingPort | null>(null);

export function WorkReadingProvider({ port, children }: { port: WorkReadingPort; children: ReactNode }) {
  return <WorkReadingContext.Provider value={port}>{children}</WorkReadingContext.Provider>;
}

export function useWorkReading(override?: WorkReadingPort): WorkReadingPort {
  const composed = useContext(WorkReadingContext);
  const port = override ?? composed;
  if (!port) throw new TypeError('Work reading port is not composed');
  return port;
}

function IsolatedWorkValue({ snak, related, locale, link: Link }: WorkReadingValueProps) {
  const o = { locale: locale as never };
  const content = snak.value.type === 'value' ? snak.value.content : undefined;
  if (snak.value.type === 'somevalue' || snak.value.type === 'novalue')
    return (
      <span className="text-muted-foreground">
        {snak.value.type === 'somevalue' ? m.subject_value_unknown({}, o) : m.subject_value_none({}, o)}
      </span>
    );
  if (snak.value.type !== 'value') return <span>{m.candidate_value_unavailable({}, o)}</span>;
  if (snak.property.data_type === 'wikibase-item' && typeof content === 'string') {
    const entry = Object.hasOwn(related, content) ? related[content] : undefined;
    const id = entry?.redirect ?? content;
    const label = pickText(entry?.labels ?? {}, locale);
    const text = label.text || m.subject_value_unlabelled({}, o);
    return (
      <Link href={subjectHref({ id, label: text }, locale).href} {...(label.lang ? { lang: label.lang } : {})}>
        {text}
      </Link>
    );
  }
  if (snak.property.data_type === 'quantity') {
    const quantity = quantityPresentation(content, related, locale);
    if (!quantity) return <span>{m.candidate_value_unavailable({}, o)}</span>;
    const unit = quantity.unitLabel ?? m.quantity_unit_unavailable({}, o);
    return (
      <span>
        {quantity.numbers}
        {unit ? ` ${unit}` : ''}
      </span>
    );
  }
  if (snak.property.data_type === 'time') {
    return <span>{typeof content === 'string' ? content : m.candidate_value_unavailable({}, o)}</span>;
  }
  if (
    snak.property.data_type === 'monolingualtext' &&
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    'language' in content &&
    typeof content.language === 'string'
  ) {
    const record = content as { language: string; text?: unknown };
    const text = pickText(typeof record.text === 'string' ? { [record.language]: record.text } : {}, locale);
    return <span {...(text.lang ? { lang: text.lang } : {})}>{text.text}</span>;
  }
  if (snak.property.data_type === 'document' || snak.property.data_type === 'media')
    return <span>{m.candidate_value_unavailable({}, o)}</span>;
  if (typeof content === 'string' && content)
    return snak.property.data_type === 'url' ? <Link href={content}>{content}</Link> : <span>{content}</span>;
  return <span>{m.candidate_value_unavailable({}, o)}</span>;
}

/** Module-local adapter for stories and tests. Live pages bind CandidateValue. */
export const isolatedWorkReading: WorkReadingPort = {
  sectionClass: workReadingSectionClass,
  renderValue: (props) => <IsolatedWorkValue {...props} />,
};
