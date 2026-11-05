import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useLayoutEffect, useMemo } from 'react';
import { defaultReader, type Reader } from '../../subject/reader';
import { useSession } from '../../session/query';
import { FollowTargetControl } from '../../library/follow-target-control';
import { ConceptAssociations, ConceptAliases, ConceptWorksDisclosure } from './source-concept-reading/associations';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { ConceptRead } from '../catalogue/source-concept-explorer';
import { actionClass, linkClass, ConceptHierarchy, visitAnnouncement } from './source-concept-reading/hierarchy';
import { useConceptVisit, type ConceptTransport } from './source-concept-reading/visit';
import { originatingConceptReturn } from './source-concept-reading/origin';
import {
  conceptVisitAddressFor,
  conceptVisitHref,
  conceptTargetHref,
  conceptVisitDescriptorFor,
  subjectVisitHref,
  type ConceptFocus,
  type ConceptHierarchyAddress,
  type ConceptVisitDescriptor,
} from './source-concept-reading/navigation';
import {
  ConceptTaggedWorks,
  type ConceptWorksRoutePatch,
  type ConceptWorksRouteState,
} from '../catalogue/concept-works/view';

export type { ConceptTransport } from './source-concept-reading/visit';

type Props = {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean;
  transport: ConceptTransport;
  initial?: ConceptRead | undefined;
  reader?: Reader | undefined;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
  conceptVisit?: ConceptVisitDescriptor | undefined;
  invalidConceptVisit?: boolean | undefined;
  hierarchyAddress?: ConceptHierarchyAddress | undefined;
  invalidHierarchy?: boolean | undefined;
  onHierarchyChange?:
    | ((address: ConceptHierarchyAddress | undefined, options?: { replace?: boolean }) => void)
    | undefined;
};

export function SourceConceptView(props: Props) {
  const admission = useCatalogueLifetime(
    JSON.stringify(['concept-explore', props.id, props.locale, props.role, props.returnTo]),
  );
  return <ConceptVisitView key={admission.generation} {...props} admission={admission} />;
}

function ConceptVisitView({
  id,
  locale,
  role,
  returnTo: suppliedReturn,
  pinUnsupported = false,
  transport,
  initial,
  reader = defaultReader,
  admission,
  worksRoute,
  onWorksChange,
  conceptVisit,
  invalidConceptVisit,
  hierarchyAddress,
  invalidHierarchy,
  onHierarchyChange,
}: {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean;
  transport: ConceptTransport;
  initial?: ConceptRead | undefined;
  reader?: Reader | undefined;
  admission: ReturnType<typeof useCatalogueLifetime>;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
  conceptVisit?: ConceptVisitDescriptor | undefined;
  invalidConceptVisit?: boolean | undefined;
  hierarchyAddress?: ConceptHierarchyAddress | undefined;
  invalidHierarchy?: boolean | undefined;
  onHierarchyChange?:
    | ((address: ConceptHierarchyAddress | undefined, options?: { replace?: boolean }) => void)
    | undefined;
}) {
  const o = { locale: locale as never };
  const returnTo = originatingConceptReturn(suppliedReturn, locale);
  const visit = useConceptVisit({
    id,
    role,
    transport,
    initial,
    admission,
    address: hierarchyAddress,
    onAddressChange: onHierarchyChange,
  });
  const { read, error, busy } = visit;
  const source = useCatalogueLifetime(
    JSON.stringify([
      read?.public.subject.id,
      read?.public.subject.context,
      read?.public.subject.release,
      read?.public.subject.revision,
      read?.session,
    ]),
    admission,
  );
  const followOrigin = useMemo(() => ({ lifetime: source, isCurrent: source.active }), [source]);
  const { state: sessionState } = useSession();
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const factsHref = catalogueEntries.facts({ id, label: title.text, locale }).href;
  const correctionReturn = returnTo ? `${factsHref}?${new URLSearchParams({ returnTo })}` : factsHref;
  const correctionAllowed =
    read?.viewerActions.state === 'available' &&
    read.viewerActions.actions.some(
      (item) => item.action === 'statement:propose' && item.operations.includes('subject.propose'),
    );
  const immediateReturn =
    conceptVisit && conceptVisit.subject !== id
      ? conceptVisitHref(conceptVisit, locale, returnTo)
      : undefined;

  const addressFor = (focus: ConceptFocus) => {
    if (!read?.admitted) return;
    return conceptVisitAddressFor(read, visit.history, visit.index, worksRoute, focus, locale, returnTo);
  };
  const hierarchyHrefFor = (base: string, row: { id: string; conceptPage: boolean }) => {
    if (!read?.admitted) return base;
    if (!row.conceptPage)
      return subjectVisitHref(base, addressFor({ section: 'hierarchy', row: row.id }));
    const descriptor = conceptVisitDescriptorFor(read, visit.history, visit.index, worksRoute, {
      section: 'hierarchy',
      row: row.id,
    });
    return conceptTargetHref(base, descriptor, returnTo);
  };
  const associationHrefFor = (base: string, focus: ConceptFocus) => {
    if (!read?.admitted) return base;
    const address = addressFor(focus);
    if (base.endsWith('/concepts')) {
      const descriptor = conceptVisitDescriptorFor(read, visit.history, visit.index, worksRoute, focus);
      return conceptTargetHref(base, descriptor, returnTo);
    }
    return subjectVisitHref(base, address);
  };
  const workReturnHref = (_subject: { id: string }) => addressFor({ section: 'works' });

  useLayoutEffect(() => {
    if (!visit.focus || visit.loading || visit.busy || !read?.admitted) return;
    const focus = visit.focus;
    const focusWithin = (selector: string, attribute: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.dataset[attribute] === focus.row);
    let target: HTMLElement | undefined;
    if (focus.row && focus.section === 'hierarchy') {
      target = focusWithin('[data-concept-hierarchy-row]', 'conceptHierarchyRow')?.querySelector('a') ?? undefined;
    } else if (focus.row && ['scheme', 'code', 'broader'].includes(focus.section)) {
      target = focusWithin('[data-concept-association-row]', 'conceptAssociationRow')?.querySelector('a[data-concept-target]') ?? undefined;
    } else if (focus.section === 'works') {
      target = document.getElementById('concept-tagged-works-heading') ?? undefined;
    }
    if (target) {
      target.focus();
      return;
    }
    visit.reportFocusMissing();
  }, [visit.focus, visit.loading, visit.busy, visit.completed, read, visit.reportFocusMissing]);

  useLayoutEffect(() => {
    if (!visit.notice || visit.loading || visit.busy) return;
    const section = visit.noticeSection ?? 'hierarchy';
    const id =
      section === 'hierarchy'
        ? 'concept-narrower-heading'
        : section === 'works'
          ? 'concept-tagged-works-heading'
          : `concept-${section}-heading`;
    document.getElementById(id)?.focus();
  }, [visit.notice, visit.noticeSection, visit.loading, visit.busy]);
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={visit.loading || busy}
    >
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1
            lang={title.lang ?? undefined}
            className="font-sans text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
          >
            {title.text || m.concept_explore_title({}, o)}
          </h1>
          {read?.admitted && <FollowTargetControl targetId={read.public.subject.id} origin={followOrigin} />}
        </div>
        {read?.definition && (
          <p className="max-w-prose whitespace-pre-line" lang={read.definition.lang ?? undefined}>
            {read.definition.text}
          </p>
        )}
        {read?.admitted && sessionState === 'signed-out' && (
          <a
            className={linkClass}
            href={`/auth/sign-in?return_to=${encodeURIComponent(catalogueEntries.concepts({ id, label: title.text, locale }).href)}`}
          >
            {m.concept_visit_follow_sign_in({}, o)}
          </a>
        )}
      </header>
      {immediateReturn && (
        <a className={linkClass} href={immediateReturn}>
          {m.concept_visit_return_previous({}, o)}
        </a>
      )}
      {(invalidConceptVisit || invalidHierarchy) && (
        <div className="space-y-2">
          <p role="status">{m.concept_visit_invalid_return({}, o)}</p>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={busy}
            onClick={() =>
              onHierarchyChange
                ? onHierarchyChange(undefined, { replace: true })
                : void visit.restart()
            }
          >
            {m.concept_visit_restart({}, o)}
          </Button>
        </div>
      )}
      {pinUnsupported && <p role="status">{m.concept_explore_pin_unsupported({}, o)}</p>}
      <p ref={visit.statusRef} role="status" tabIndex={-1} aria-live="polite" aria-atomic="true">
        {visitAnnouncement(visit, locale)}
      </p>
      {visit.notice && visit.hierarchy?.state !== 'available' && visit.hierarchy?.state !== 'lagging' && (
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={busy}
          onClick={() => void visit.restart()}
        >
          {m.concept_visit_restart({}, o)}
        </Button>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" tabIndex={-1}>
            {'oversized' in error && error.oversized
              ? m.concept_visit_oversized({}, o)
              : error.reason === 'denied'
                ? m.concept_explore_denied({}, o)
                : m.concept_explore_unreadable({}, o)}
          </p>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={busy}
            onClick={() => void visit.retry()}
          >
            {m.concept_explore_retry({}, o)}
          </Button>
        </div>
      )}
      {read && (
        <div className="space-y-6">
          <section className="space-y-2">
            <details className="space-y-2">
              <summary className={linkClass}>{m.concept_visit_identity({}, o)}</summary>
              <label className="block">
                {m.concept_explore_identity({}, o)}
                <input
                  className="block w-full font-mono"
                  readOnly
                  value={read.public.subject.id}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <p>
                {m.concept_explore_type({}, o)}: <code>{read.public.subject.type}</code>
              </p>
              <p>
                {m.concept_explore_source_release({}, o)}: <code>{read.public.subject.release}</code>
              </p>
              <p>
                {m.own_drafts_revision({}, o)}: {read.public.subject.revision}
              </p>
              <p>
                {m.prq_context({}, o)}: <code>{read.public.subject.context}</code>
              </p>
            </details>
            {read.retired === true && <p role="status">{m.concept_explore_retired({}, o)}</p>}
            {read.retired === null && <p>{m.concept_explore_release_unknown({}, o)}</p>}
            {!read.admitted && <p role="status">{m.concept_explore_unsupported({}, o)}</p>}
            {pinUnsupported && <p>{m.concept_explore_pin_unsupported_detail({}, o)}</p>}
            {read.aliases.length > 0 && (
              <section className="space-y-2">
                <h2 className="font-sans text-lg font-semibold">{m.concept_explore_aliases({}, o)}</h2>
                <ConceptAliases aliases={read.aliases} locale={locale} />
              </section>
            )}
          </section>

          {role !== undefined && (
            <section className="space-y-2" aria-labelledby="concept-requested-role">
              <h2 id="concept-requested-role" className="font-sans text-lg font-semibold">
                {m.concept_explore_original_role({}, o)}
              </h2>
              <p>
                <code dir="auto">{role}</code>
              </p>
              <p className="text-sm text-muted-foreground">{m.concept_explore_role_evidence({}, o)}</p>
            </section>
          )}

          {read.admitted && (
            <>
              <ConceptAssociations
                key={JSON.stringify([source.generation, reader, visit.completed])}
                read={read.public}
                codes={read.codes}
                locale={locale}
                reader={reader}
                returnTo={returnTo}
                hrefFor={associationHrefFor}
              />

              <ConceptHierarchy visit={visit} locale={locale} returnTo={returnTo} hrefFor={hierarchyHrefFor} />

              <section className="space-y-2" aria-labelledby="concept-actions-heading">
                <h2 id="concept-actions-heading" className="font-sans text-lg font-semibold">
                  {m.concept_explore_actions({}, o)}
                </h2>
                {correctionAllowed ? (
                  <a className={linkClass} href={correctionReturn}>
                    {m.concept_explore_correct({}, o)}
                  </a>
                ) : read.viewerActions.state === 'unavailable' ? (
                  <p role="status">{m.concept_explore_actions_unavailable({}, o)}</p>
                ) : read.viewerActions.account === null ? (
                  <p>
                    {m.concept_explore_sign_in({}, o)}{' '}
                    <a className={linkClass} href={`/auth/sign-in?return_to=${encodeURIComponent(correctionReturn)}`}>
                      {m.account_sign_in({}, o)}
                    </a>
                  </p>
                ) : (
                  <p role="status">{m.concept_explore_read_only({}, o)}</p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  disabled={busy}
                  onClick={() => void visit.refresh()}
                >
                  {m.concept_explore_refresh_actions({}, o)}
                </Button>
              </section>
            </>
          )}
        </div>
      )}
      {read?.ok && (
        <ConceptWorksDisclosure
          key={JSON.stringify([source.generation, reader, visit.completed])}
          read={read}
          reader={reader}
          locale={locale}
        >
          {(presentation) => (
            <ConceptTaggedWorks
              read={presentation}
              locale={locale}
              route={{ ...(worksRoute ?? {}), role, returnTo }}
              onChange={onWorksChange}
              conceptReturnForResult={workReturnHref}
            />
          )}
        </ConceptWorksDisclosure>
      )}
      {returnTo && (
        <a className={linkClass} href={returnTo}>
          {m.concept_explore_return({}, o)}
        </a>
      )}
    </article>
  );
}
