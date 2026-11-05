import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import type { FactsPublicOrigin } from './facts-public-visit';
import { m } from '../../paraglide/messages.js';

export function SubjectFactsEntry({
  id,
  label,
  locale,
  origin,
}: {
  id: string;
  label: string;
  locale: string;
  origin?: FactsPublicOrigin | undefined;
}) {
  const entry = catalogueEntries.facts({ id, label, locale, origin });
  return (
    <a href={entry.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {entry.label}
    </a>
  );
}

export function FactsPublicVisitNotice({
  state,
  returnHref,
  freshHref,
  locale,
}: {
  state: 'unsupported' | 'invalid' | 'fresh';
  returnHref: string;
  freshHref?: string | undefined;
  locale: string;
}) {
  const o = { locale: locale as never };
  const message =
    state === 'unsupported'
      ? m.facts_public_unsupported({}, o)
      : state === 'invalid'
        ? m.facts_public_invalid({}, o)
        : m.facts_public_fresh_notice({}, o);
  return (
    <section
      role={state === 'fresh' ? 'status' : 'alert'}
      aria-live={state === 'fresh' ? 'polite' : 'assertive'}
      className="space-y-3 rounded-lg border border-border bg-background p-4 text-sm"
      data-facts-public-visit={state}
    >
      <p>{message}</p>
      <div className="flex flex-wrap gap-3">
        <FactsPublicReturnLink href={returnHref} locale={locale} />
        {state === 'unsupported' && freshHref && (
          <a
            className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            href={freshHref}
          >
            {m.facts_public_fresh_global({}, o)}
          </a>
        )}
      </div>
    </section>
  );
}

export function FactsPublicReturnLink({ href, locale }: { href: string; locale: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      href={href}
    >
      {m.facts_public_return({}, { locale: locale as never })}
    </a>
  );
}
