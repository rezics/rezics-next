import { createFileRoute, useLocation } from '@tanstack/react-router';
import { SubjectTermsSession } from '../../features/catalogue/subject-terms-session';
import { SubjectTermsPublicVisitNotice } from '../../features/catalogue/subject-terms-entry';
import { parseTermsPublicVisit, termsPublicVisitUnsupported } from '../../features/catalogue/terms-public-visit';
import { NamesTermsReturn } from '../../features/catalogue/work-names/navigation';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/terms')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    via: subjectVisitReturn(input.via, getLocale()),
    returnToChanges: input.returnTo === 'changes' ? true : undefined,
  }),
  head: () => ({ meta: [{ title: m.catalogue_terms_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: TermsRoute,
});

function TermsRoute() {
  const { id } = Route.useParams();
  const { slug } = Route.useParams();
  const { returnToChanges, via } = Route.useSearch();
  const locale = getLocale();
  const location = useLocation();
  const visit = parseTermsPublicVisit(location.searchStr, id, locale);
  if (visit.kind === 'invalid' || (visit.kind === 'origin' && termsPublicVisitUnsupported(visit))) {
    return (
      <>
        {via ? <NamesTermsReturn id={id} locale={locale} via={via} /> : null}
        <SubjectTermsPublicVisitNotice
          visit={visit}
          id={id}
          slug={slug}
          locale={locale}
          showGeneralReturn={visit.kind !== 'origin' || !visit.via}
        />
      </>
    );
  }
  const returnHref =
    visit.kind === 'origin' ? visit.origin.returnHref : visit.kind === 'fresh' ? visit.returnHref : undefined;
  const showGeneralReturn = returnHref !== undefined && !(visit.kind !== 'legacy' && visit.via);
  const freshSessionKey =
    visit.kind === 'origin'
      ? JSON.stringify(['origin', visit.origin])
      : visit.kind === 'fresh'
        ? JSON.stringify(visit)
        : 'legacy';
  return (
    <>
      {showGeneralReturn && (
        <div className="mx-auto w-full max-w-4xl px-6 pt-4">
          <a className="inline-flex min-h-11 items-center text-primary underline underline-offset-4" href={returnHref}>
            {m.subject_terms_public_return({}, { locale: locale as never })}
          </a>
        </div>
      )}
      <SubjectTermsSession
        key={freshSessionKey}
        id={id}
        locale={locale}
        returnToChanges={returnToChanges === true}
        via={via}
      />
    </>
  );
}
