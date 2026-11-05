import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { benefitReaderHref, type CapturedBenefit } from './benefit';

/** Captured purchase terms are kept separate from the reader's current availability decision. */
export function BenefitDetails({
  benefit,
  locale,
  creatorName,
  active = false,
  review = false,
  onOpenReader,
}: {
  benefit: CapturedBenefit;
  locale: string;
  creatorName?: string | undefined;
  active?: boolean;
  review?: boolean;
  onOpenReader?: (editionId: string, href: string) => boolean;
}) {
  if (benefit.kind !== 'mapped')
    return (
      <Alert>
        <AlertDescription>
          {benefit.kind === 'unknown' ? m.benefit_details_unknown() : m.benefit_terms_unavailable()}
        </AlertDescription>
      </Alert>
    );
  const href = review ? null : benefitReaderHref(benefit, active, locale);
  return (
    <section className="min-w-0 space-y-4" aria-label={m.benefit_heading()}>
      <h2 className="text-xl font-semibold">{m.benefit_heading()}</h2>
      <p className="max-w-prose text-sm leading-relaxed">{m.benefit_fixed_version()}</p>
      <dl className="grid min-w-0 grid-cols-1 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-3 [&>dt]:text-muted-foreground [&>dd]:mb-3 [&>dd]:break-words sm:[&>dd]:mb-0">
        <dt>{m.benefit_acquisition_label()}</dt>
        <dd>{m.benefit_acquisition()}</dd>
        <dt>{m.benefit_creator()}</dt>
        <dd>{creatorName ?? m.benefit_creator_unavailable()}</dd>
        <dt>{m.benefit_licence()}</dt>
        <dd>{benefit.terms.source.licence}</dd>
      </dl>
      {!review && <p className="max-w-prose text-sm text-muted-foreground">{m.benefit_reader_notice()}</p>}
      {href ? (
        <a
          href={href}
          className={buttonVariants({ className: 'min-h-11 w-full sm:w-auto' })}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.currentTarget.target === '_blank'
            )
              return;
            if (onOpenReader?.(benefit.terms.benefit.resource.id, href)) event.preventDefault();
          }}
        >
          {m.benefit_open_reader()}
        </a>
      ) : null}
    </section>
  );
}
