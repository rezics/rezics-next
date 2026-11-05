import { useEffect, useRef } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';

const actionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center whitespace-normal break-words py-2 underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function CatalogueFileProfileContextUnavailable({
  locale,
  returnHref,
  globalHref,
}: {
  locale: string;
  returnHref?: string | undefined;
  globalHref: string;
}) {
  const o = { locale: locale as never };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6" data-slot="catalogue-file-context-unsupported">
      <h1 ref={heading} className="font-sans text-2xl font-semibold" tabIndex={-1}>
        {m.catalogue_file_title({}, o)}
      </h1>
      <p role="status">{m.catalogue_file_context_unsupported({}, o)}</p>
      <nav className="flex flex-wrap gap-2">
        {returnHref ? (
          <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={returnHref}>
            {m.catalogue_file_reader_return({}, o)}
          </a>
        ) : null}
        <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={globalHref}>
          {m.catalogue_file_global_correction_entry({}, o)}
        </a>
      </nav>
    </section>
  );
}
