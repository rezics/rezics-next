import { Badge } from '@rezics/ui/badge';
import { CircleAlertIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { type Copy, copyOf } from './messages.ts';

/** What a Work's header says about who entered it, as Main gives it. */
export interface Provenance { contributor: string; candidateReceipt: string; fields: readonly string[] }

const fieldKeys = { title: 'fieldTitle', language: 'fieldLanguage', grain: 'fieldGrain',
  parentComposition: 'fieldParentComposition', localizedTitle: 'fieldLocalizedTitle', description: 'fieldDescription',
  semanticTypes: 'fieldSemanticTypes', aliases: 'fieldAliases', romanizations: 'fieldRomanizations' } as const satisfies
  Record<string, keyof Copy>;

/** A field's name in words; a field this page has no words for is left out rather than shown as a raw key. */
const fieldName = (field: string, t: Copy) => field in fieldKeys ? t[fieldKeys[field as keyof typeof fieldKeys]] : null;

/**
 * A provisional record's mark: the unverified badge with what it means and which fields its
 * contributor entered, until a reviewer verifies it. Nothing shows for a verified Work or one
 * Main did not mark, so this is safe on every Work page.
 */
export function ProvisionalNotice({ verification, provenance, locale, className }: {
  verification: 'unverified' | 'verified' | null | undefined; provenance?: Provenance | null; locale: UiLocale;
  className?: string;
}) {
  if (verification !== 'unverified') return null;
  const t = copyOf(locale);
  return <aside aria-label={t.noticeBadge} data-provisional="" className={className}>
    <div className="grid gap-2 rounded-2xl border border-warning/40 bg-warning/8 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning"><CircleAlertIcon aria-hidden="true" />{t.noticeBadge}</Badge>
        <span className="text-foreground">{t.noticeBody}</span>
      </div>
      {provenance ? <details className="text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm underline decoration-dotted underline-offset-4 outline-none
          hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t.provenanceHeading}</summary>
        <div className="mt-2 grid gap-2">
          <p>{t.provenanceBody}</p>
          <ul data-provenance-fields="" className="flex flex-wrap gap-1.5">
            {provenance.fields.flatMap(field => fieldName(field, t) ?? []).map(name => <li key={name}><Badge variant="outline">{name}</Badge></li>)}
          </ul>
        </div>
      </details> : null}
    </div>
  </aside>;
}
