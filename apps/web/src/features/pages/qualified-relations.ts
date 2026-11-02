import type { SubjectSummary } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import { quantityPresentation } from '../../subject/quantity-presentation';
import type { Related } from '../../subject/types';
import { isRecord, type Stmt } from './shared';

type QuantityContent = { amount: string; unit: string; lowerBound?: string; upperBound?: string };
type QualifiedQuantity = {
  content: QuantityContent;
  presentation: NonNullable<ReturnType<typeof quantityPresentation>>;
};

export type QualifiedNote = {
  text: string;
  property?: string;
  subject?: { id: string; label: string };
  language?: string;
  quantity?: QualifiedQuantity;
};

/** Preserve one statement's qualifiers. Item labels come only from this response's disclosed related projection. */
export function qualifiedNotes(statement: Stmt, related: unknown, locale: string): QualifiedNote[] {
  const options = { locale: locale as never };
  const labels: Record<string, string> = {
    'wdt:P1932': m.subject_credit_named({}, options),
    'wdt:P1545': m.subject_credit_order({}, options),
    'schema:position': m.subject_credit_order({}, options),
    'wdt:P3831': m.subject_credit_role({}, options),
    'wdt:P453': m.subject_credit_character({}, options),
    'schema:character': m.subject_credit_character({}, options),
    'wdt:P518': m.subject_credit_part({}, options),
  };
  const disclosed = isRecord(related) ? (related as Related) : {};
  return statement.qualifiers.flatMap((snak): QualifiedNote[] => {
    if (!Object.hasOwn(labels, snak.property.id)) return [];
    const prefix = labels[snak.property.id]!;
    const property = snak.property.id;
    if (snak.value.type === 'somevalue' || snak.value.type === 'novalue')
      return [
        {
          property,
          text: `${prefix}: ${
            snak.value.type === 'somevalue' ? m.subject_value_unknown({}, options) : m.subject_value_none({}, options)
          }`,
        },
      ];
    if (snak.value.type !== 'value') return [];
    const content = snak.value.content;
    if (snak.property.data_type === 'wikibase-item' && typeof content === 'string') {
      const summary = Object.hasOwn(disclosed, content)
        ? (disclosed[content] as SubjectSummary | undefined)
        : undefined;
      const label = typeof summary?.label === 'object' ? summary.label?.value : undefined;
      return summary && label
        ? [{ property, text: `${prefix}: ${label}`, subject: { id: summary.id, label } }]
        : [{ property, text: `${prefix}: ${m.subject_value_unknown({}, options)}` }];
    }
    if (
      (snak.property.data_type === 'string' || snak.property.data_type === 'external-id') &&
      typeof content === 'string'
    )
      return [{ property, text: `${prefix}: ${content}` }];
    if (
      snak.property.data_type === 'monolingualtext' &&
      isRecord(content) &&
      typeof content.text === 'string' &&
      typeof content.language === 'string'
    )
      return [{ property, text: `${prefix}: ${content.text}`, language: content.language }];
    if (snak.property.data_type === 'quantity') {
      // Relation reads disclose summaries, while the shared presenter reads localized label maps.
      const units: Related = {};
      if (isRecord(content) && typeof content.unit === 'string' && Object.hasOwn(disclosed, content.unit)) {
        const summary = disclosed[content.unit] as SubjectSummary | undefined;
        const label = summary?.label;
        if (label && typeof label === 'object') units[content.unit] = { labels: { [label.language]: label.value } };
      }
      const presentation = quantityPresentation(content, units, locale);
      return presentation && isRecord(content)
        ? [{ property, text: `${prefix}:`, quantity: { content: content as QuantityContent, presentation } }]
        : [{ property, text: `${prefix}: ${m.subject_value_unknown({}, options)}` }];
    }
    return [];
  });
}
