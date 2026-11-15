import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from './catalogue-entry';
import type { AuthoredPublicOrigin } from './authored-public-visit';
import { m } from '../../paraglide/messages.js';

export function AuthoredFieldEntry({
  id,
  title,
  locale,
  origin,
}: {
  id: string;
  title: string;
  locale: string;
  origin?: AuthoredPublicOrigin | undefined;
}) {
  const entry = catalogueEntries.authored({ id, title, locale, origin });
  return (
    <a
      href={entry.href}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
    >
      {entry.label}
    </a>
  );
}

export function AuthoredPublicVisitNotice({
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
      ? m.authored_public_unsupported({}, o)
      : state === 'invalid'
        ? m.authored_public_invalid({}, o)
        : m.authored_public_fresh_notice({}, o);
  return (
    <section
      role={state === 'fresh' ? 'status' : 'alert'}
      aria-live={state === 'fresh' ? 'polite' : 'assertive'}
      className="space-y-3 rounded-lg border border-border bg-background p-4 text-sm"
      data-authored-public-visit={state}
    >
      <p>{message}</p>
      <div className="flex flex-wrap gap-3">
        <a
          className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={returnHref}
        >
          {m.authored_public_return({}, o)}
        </a>
        {state === 'unsupported' && freshHref && (
          <a
            className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            href={freshHref}
          >
            {m.authored_public_fresh_global({}, o)}
          </a>
        )}
      </div>
    </section>
  );
}

export function AuthoredPublicReturnLink({ href, locale }: { href: string; locale: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      href={href}
    >
      {m.authored_public_return({}, { locale: locale as never })}
    </a>
  );
}
