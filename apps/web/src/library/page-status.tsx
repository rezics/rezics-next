import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';

export function LibraryPageStatus({
  title,
  locale,
  children,
}: {
  title: string;
  locale?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 max-w-2xl space-y-4">
      {locale ? (
        <a
          href={`/${locale}/library`}
          className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {m.library_heading({}, { locale: locale as never })}
        </a>
      ) : null}
      <PageHeading>{title}</PageHeading>
      <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
