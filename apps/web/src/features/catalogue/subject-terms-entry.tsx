import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { termsGlobalVisitHref, type TermsPublicVisit } from './terms-public-visit';
import { m } from '../../paraglide/messages.js';

export function SubjectTermsEntry({
  id,
  label,
  locale,
  origin,
}: {
  id: string;
  label: string;
  locale: string;
  origin?: Parameters<typeof catalogueEntries.terms>[0]['origin'];
}) {
  const entry = catalogueEntries.terms({ id, label, locale, ...(origin ? { origin } : {}) });
  return (
    <a href={entry.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {entry.label}
    </a>
  );
}

export function SubjectTermsPublicVisitNotice({
  visit,
  id,
  slug,
  locale,
  showGeneralReturn,
}: {
  visit: Exclude<TermsPublicVisit, { kind: 'legacy' }>;
  id: string;
  slug: string;
  locale: string;
  showGeneralReturn: boolean;
}) {
  if (visit.kind === 'invalid') {
    return (
      <section className="mx-auto w-full max-w-4xl space-y-3 px-6 py-6" role="alert">
        <p>{m.subject_terms_public_invalid({}, { locale: locale as never })}</p>
      </section>
    );
  }
  const returnHref = visit.kind === 'origin' ? visit.origin.returnHref : visit.returnHref;
  const freshHref =
    visit.kind === 'origin'
      ? termsGlobalVisitHref(
          `/${locale}/subjects/${encodeURIComponent(id)}/${encodeURIComponent(slug)}/terms`,
          id,
          locale,
          visit.origin.returnHref,
          visit.via,
        )
      : undefined;
  return (
    <section className="mx-auto w-full max-w-4xl space-y-3 px-6 py-6" role="status">
      <p>{m.subject_terms_public_unsupported({}, { locale: locale as never })}</p>
      <nav
        className="flex flex-wrap gap-3"
        aria-label={m.subject_terms_public_navigation({}, { locale: locale as never })}
      >
        {showGeneralReturn && (
          <a href={returnHref} className="min-h-11 rounded-sm text-primary underline underline-offset-4">
            {m.subject_terms_public_return({}, { locale: locale as never })}
          </a>
        )}
        {freshHref && (
          <a href={freshHref} className="min-h-11 rounded-sm text-primary underline underline-offset-4">
            {m.subject_terms_public_fresh_global({}, { locale: locale as never })}
          </a>
        )}
      </nav>
    </section>
  );
}
