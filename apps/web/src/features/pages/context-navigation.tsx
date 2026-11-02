import type { SelectedContext } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';

const recoveryLinkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md border border-border px-3 py-2 text-left whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

/** Keep subject navigation in its population and reset continuation when changing selection. */
export function contextHref(href: string, realm?: string, options: { resetSelection?: boolean } = {}): string {
  if ((!realm && !options.resetSelection) || !/^\/[^/]+\/subjects\//.test(href)) return href;
  const url = new URL(href, 'https://rezics.invalid');
  if (options.resetSelection) {
    for (const key of ['realm', 'context', 'node', 'cursor']) url.searchParams.delete(key);
  }
  if (realm) url.searchParams.set('realm', realm);
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
    <nav
      data-slot="page-context"
      aria-label={m.subject_context_navigation({}, o)}
      className="min-w-0 space-y-3 rounded-lg border border-border p-4 text-sm"
    >
      <p className="font-medium break-words">
        {selected ? m.subject_context_selected({ title: selected.title }, o) : m.subject_context_global({}, o)}
      </p>
      {!selected && <p className="text-muted-foreground">{m.subject_context_fallback({}, o)}</p>}
      <div className="grid gap-3 sm:flex sm:flex-wrap">
        {selected && (
          <a className={recoveryLinkClass} href={`/${locale}/realms/${selected.id}`}>
            {m.subject_context_return({ title: selected.title }, o)}
          </a>
        )}
        <a className={recoveryLinkClass} href={contextHref(href, undefined, { resetSelection: true })}>
          {m.subject_context_switch_global({}, o)}
        </a>
        {!selected && selection && (
          <a className={recoveryLinkClass} href={contextHref(href, selection, { resetSelection: true })}>
            {m.subject_context_retry({}, o)}
          </a>
        )}
      </div>
    </nav>
  );
}
