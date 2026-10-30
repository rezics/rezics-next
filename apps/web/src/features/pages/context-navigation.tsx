import type { SelectedContext } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';

/** Retain only the requested Realm selector. Context ids and cursors never become link authority. */
export function contextHref(href: string, realm?: string): string {
  if (!realm || !/^\/[^/]+\/subjects\//.test(href)) return href;
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set('realm', realm);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Population labels come only from the current page response, including an explicitly labelled Global fallback. */
export function ContextNavigation({
  context,
  realm,
  href,
  locale,
}: {
  context?: SelectedContext | undefined;
  realm?: string | undefined;
  href: string;
  locale: string;
}) {
  if (!realm && context?.population.kind !== 'realm') return null;
  const o = { locale: locale as never };
  const selected = context?.population.kind === 'realm' ? context.population : undefined;
  const selection = realm ?? selected?.id;
  return (
    <nav data-slot="page-context" aria-label={m.subject_context_navigation({}, o)} className="space-y-2 text-sm">
      <p className="font-medium break-words">
        {selected ? m.subject_context_selected({ title: selected.title }, o) : m.subject_context_global({}, o)}
      </p>
      {!selected && <p className="text-muted-foreground">{m.subject_context_fallback({}, o)}</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {selected && (
          <a className="text-primary underline underline-offset-4" href={`/${locale}/realms/${selected.id}`}>
            {m.subject_context_return({ title: selected.title }, o)}
          </a>
        )}
        <a className="text-primary underline underline-offset-4" href={href}>
          {m.subject_context_switch_global({}, o)}
        </a>
        {!selected && selection && (
          <a className="text-primary underline underline-offset-4" href={contextHref(href, selection)}>
            {m.subject_context_retry({}, o)}
          </a>
        )}
      </div>
    </nav>
  );
}
