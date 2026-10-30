import type { SubjectSummary } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import { isRecord, type Stmt } from './shared';

export type QualifiedNote = { text: string; subject?: { id: string; label: string }; language?: string };

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
  };
  return statement.qualifiers.flatMap((snak): QualifiedNote[] => {
    if (snak.value.type !== 'value' || !Object.hasOwn(labels, snak.property.id)) return [];
    const prefix = labels[snak.property.id]!;
    const content = snak.value.content;
    if (snak.property.data_type === 'wikibase-item' && typeof content === 'string') {
      const summary =
        isRecord(related) && Object.hasOwn(related, content)
          ? (related[content] as SubjectSummary | undefined)
          : undefined;
      const label = typeof summary?.label === 'object' ? summary.label?.value : undefined;
      return summary && label ? [{ text: `${prefix}: ${label}`, subject: { id: summary.id, label } }] : [];
    }
    if (
      (snak.property.data_type === 'string' || snak.property.data_type === 'external-id') &&
      typeof content === 'string'
    )
      return [{ text: `${prefix}: ${content}` }];
    if (
      snak.property.data_type === 'monolingualtext' &&
      isRecord(content) &&
      typeof content.text === 'string' &&
      typeof content.language === 'string'
    )
      return [{ text: `${prefix}: ${content.text}`, language: content.language }];
    if (snak.property.data_type === 'quantity' && isRecord(content) && typeof content.amount === 'string')
      return [{ text: `${prefix}: ${content.amount}` }];
    return [];
  });
}
