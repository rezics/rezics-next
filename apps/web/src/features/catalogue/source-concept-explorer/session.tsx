import { useQuery } from '@tanstack/react-query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectReaderQuery } from '../../pages/subject-queries';
import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { SourceConceptView } from '../../pages/source-concept-view';
import { readSubjectConcept } from './actions';
import type { ConceptWorksRoutePatch, ConceptWorksRouteState } from '../concept-works/view';
import type { ConceptHierarchyAddress, ConceptVisitDescriptor } from '../../pages/source-concept-reading/navigation';
import { conceptGlobalVisitHref, type ConceptPublicVisit } from './public-visit';

type SourceConceptSessionProps = {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean | undefined;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
  conceptVisit?: ConceptVisitDescriptor | undefined;
  invalidConceptVisit?: boolean | undefined;
  hierarchyAddress?: ConceptHierarchyAddress | undefined;
  invalidHierarchy?: boolean | undefined;
  onHierarchyChange?:
    | ((address: ConceptHierarchyAddress | undefined, options?: { replace?: boolean }) => void)
    | undefined;
  publicVisitKey?: string | undefined;
};

export const SourceConceptSession = candidateSession(function SourceConceptSessionLive({
  id,
  locale,
  role,
  returnTo,
  pinUnsupported,
  worksRoute,
  onWorksChange,
  conceptVisit,
  invalidConceptVisit,
  hierarchyAddress,
  invalidHierarchy,
  onHierarchyChange,
  publicVisitKey,
}: SourceConceptSessionProps) {
  const work = useCatalogueLifetime(JSON.stringify(['concept-explore', id, locale, role, returnTo, publicVisitKey]));
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  const preferences = useQuery({
    ...subjectReaderQuery(id, locale, {
      reader: expectedReader,
      admission: work.generation,
      view: 'concepts',
      cacheEpoch: 0,
      isCurrent: work.active,
    }),
    enabled: state === 'signed-in',
  });
  if (state === 'unknown') return <p>{m.concept_explore_loading({}, { locale: locale as never })}</p>;
  return (
    <SourceConceptView
      key={work.generation}
      id={id}
      locale={locale}
      role={role}
      reader={!preferences.isError && !preferences.isFetching ? preferences.data?.preferences : undefined}
      returnTo={returnTo}
      {...(pinUnsupported === undefined ? {} : { pinUnsupported })}
      worksRoute={worksRoute}
      onWorksChange={onWorksChange}
      conceptVisit={conceptVisit}
      invalidConceptVisit={invalidConceptVisit}
      hierarchyAddress={hierarchyAddress}
      invalidHierarchy={invalidHierarchy}
      onHierarchyChange={onHierarchyChange}
      transport={{
        read: (next) =>
          readSubjectConcept({
            data: {
              id,
              locale,
              expectedReader,
              role,
              cursor: next.cursor,
              ...(next.membership ? { membership: next.membership } : {}),
              session: next.session,
            },
            headers: csrfHeaders(),
          }),
      }}
    />
  );
});

/** Admit the outer public observation before the original Concept reader or its transport mounts. */
export function SourceConceptPublicSession({
  publicVisit,
  pathname,
  ...sessionProps
}: Omit<SourceConceptSessionProps, 'publicVisitKey'> & {
  publicVisit?: ConceptPublicVisit | undefined;
  pathname: string;
}) {
  const { locale } = sessionProps;
  const options = { locale: locale as never };
  if (!publicVisit) return <SourceConceptSession {...sessionProps} />;
  if (publicVisit.kind === 'invalid')
    return (
      <section className="mx-auto w-full max-w-4xl space-y-3" aria-live="polite">
        <p role="status">{m.concept_public_origin_invalid({}, options)}</p>
      </section>
    );
  if (publicVisit.kind === 'unsupported') {
    const message =
      publicVisit.reason === 'realm'
        ? m.concept_public_origin_realm_unsupported({}, options)
        : publicVisit.reason === 'context'
          ? m.concept_public_origin_context_unsupported({}, options)
          : m.concept_public_origin_return_unsupported({}, options);
    return (
      <section className="mx-auto w-full max-w-4xl space-y-3" aria-live="polite">
        <p role="status">{message}</p>
        <div className="flex flex-wrap gap-2">
          <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={publicVisit.origin.returnHref}>
            {m.concept_public_origin_return({}, options)}
          </a>
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={conceptGlobalVisitHref(pathname, publicVisit.origin.returnHref)}
          >
            {m.concept_public_origin_global({}, options)}
          </a>
        </div>
      </section>
    );
  }
  const returnHref = publicVisit.kind === 'origin' ? publicVisit.origin.returnHref : publicVisit.returnHref;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={returnHref}>
        {m.concept_public_origin_return({}, options)}
      </a>
      <SourceConceptSession {...sessionProps} publicVisitKey={JSON.stringify(publicVisit)} />
    </div>
  );
}
