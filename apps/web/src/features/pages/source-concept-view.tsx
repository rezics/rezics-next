import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import { useCandidateReading, type CandidateReading } from './candidate-reading-application';
import { subjectHref } from '../../subject/load-subject';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { defaultReader, type Reader } from '../../subject/reader';
import { useSession } from '../../session/query';
import { useSearchLibraryActionHost } from '../../search/library-action-port';
import { ConceptAssociations, ConceptAliases, ConceptWorksDisclosure } from './source-concept-reading/associations';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { ConceptRead } from '../catalogue/source-concept-explorer';
import { actionClass, linkClass, ConceptHierarchy, visitAnnouncement } from './source-concept-reading/hierarchy';
import { ConceptMembershipReading } from './source-concept-reading/membership';
import {
  useConceptVisit,
  type ConceptPage,
  type ConceptTransport,
} from './source-concept-reading/visit';
import { originatingConceptReturn } from './source-concept-reading/origin';
import {
  conceptVisitAddressFor,
  conceptVisitHref,
  conceptTargetHref,
  conceptVisitDescriptorFor,
  subjectVisitHref,
  currentnessMatches,
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

type PresentationIntent = {
  key: string;
  focusAtStart?: ConceptFocus | undefined;
  sourceGeneration?: number | undefined;
  cancelled: boolean;
  consumed: boolean;
  start: () => void;
  stop: () => void;
};

function watchPresentationIntent(
  key: string,
  focusAtStart?: ConceptFocus | undefined,
  sourceGeneration?: number | undefined,
): PresentationIntent {
  const trigger = document.activeElement;
  let listening = false;
  let intent: PresentationIntent;
  const movement = (event: Event) => {
    if (event.type === 'focusin' && event.target === trigger) return;
    intent.cancelled = true;
    intent.stop();
  };
  const start = () => {
    if (listening || intent.cancelled || intent.consumed) return;
    listening = true;
    for (const name of ['focusin', 'pointerdown', 'keydown']) document.addEventListener(name, movement, true);
  };
  const stop = () => {
    if (!listening) return;
    listening = false;
    for (const name of ['focusin', 'pointerdown', 'keydown']) document.removeEventListener(name, movement, true);
  };
  intent = { key, focusAtStart, sourceGeneration, cancelled: false, consumed: false, start, stop };
  intent.start();
  return intent;
}

function sameFocus(left: ConceptFocus | undefined, right: ConceptFocus | undefined) {
  return left?.section === right?.section && left?.row === right?.row;
}

function currentAddressMatches(
  history: { addresses: (string | undefined)[]; truncated: boolean },
  index: number,
  read: ConceptPage | undefined,
  address: ConceptHierarchyAddress | undefined,
) {
  return (
    !address ||
    (!!read &&
      currentnessMatches(read, address) &&
      index === address.index &&
      history.truncated === address.truncated &&
      history.addresses.length === address.addresses.length &&
      address.addresses.every((cursor, addressIndex) => history.addresses[addressIndex] === (cursor ?? undefined)))
  );
}

function focusTargetFor(article: HTMLElement, focus: ConceptFocus): HTMLElement | undefined {
  if (focus.row && focus.section === 'hierarchy') {
    const row = [...article.querySelectorAll<HTMLElement>('[data-concept-hierarchy-row]')].find(
      (element) => element.dataset.conceptHierarchyRow === focus.row,
    );
    return row?.querySelector<HTMLElement>('a') ?? undefined;
  }
  if (focus.row && ['scheme', 'code', 'broader'].includes(focus.section)) {
    const row = [...article.querySelectorAll<HTMLElement>('[data-concept-association-row]')].find(
      (element) => element.dataset.conceptAssociationRow === focus.row,
    );
    return row?.querySelector<HTMLElement>('a[data-concept-target]') ?? undefined;
  }
  if (focus.section === 'works') {
    return article.querySelector<HTMLElement>('[id="concept-tagged-works-heading"]') ?? undefined;
  }
  return undefined;
}

function focusRowMissingFor(article: HTMLElement, focus: ConceptFocus): boolean {
  if (focus.row && focus.section === 'hierarchy') {
    return ![...article.querySelectorAll<HTMLElement>('[data-concept-hierarchy-row]')].some(
      (element) => element.dataset.conceptHierarchyRow === focus.row,
    );
  }
  if (focus.row && ['scheme', 'code', 'broader'].includes(focus.section)) {
    return ![...article.querySelectorAll<HTMLElement>('[data-concept-association-row]')].some(
      (element) => element.dataset.conceptAssociationRow === focus.row,
    );
  }
  return false;
}

function noticeTargetFor(article: HTMLElement, section: ConceptFocus['section']): HTMLElement | undefined {
  const id =
    section === 'hierarchy'
      ? 'concept-narrower-heading'
      : section === 'works'
        ? 'concept-tagged-works-heading'
        : `concept-${section}-heading`;
  return article.querySelector<HTMLElement>(`[id="${id}"]`) ?? undefined;
}

function visibleArticleTarget(article: HTMLElement, target: HTMLElement): boolean {
  if (!article.isConnected || !target.isConnected || !article.contains(target)) return false;
  if (target.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden' && target.getClientRects().length > 0;
}

export function SourceConceptView(props: Props) {
  const admission = useCandidateReading({
    candidate: 'concept-explore',
    locale: props.locale,
    address: [props.id, props.role, props.returnTo],
  });
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
  admission: CandidateReading;
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
  const articleRef = useRef<HTMLElement>(null);
  const returnAddress =
    hierarchyAddress ??
    (conceptVisit
      ? {
          subject: conceptVisit.subject,
          ...(conceptVisit.role ? { role: conceptVisit.role } : {}),
          current: conceptVisit.current,
          addresses: conceptVisit.addresses,
          index: conceptVisit.index,
          truncated: conceptVisit.truncated,
          focus: conceptVisit.focus,
        }
      : undefined);
  const routeAddressKey = returnAddress ? JSON.stringify([id, role, returnAddress]) : undefined;
  const routeFocus = returnAddress?.focus;
  const routeIntentRef = useRef<PresentationIntent | undefined>(undefined);
  const previousRouteIntentRef = useRef<PresentationIntent | undefined>(undefined);
  const noticeIntentRef = useRef<PresentationIntent | undefined>(undefined);
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
  const reportFocusMissingRef = useRef(visit.reportFocusMissing);
  reportFocusMissingRef.current = visit.reportFocusMissing;
  const statusRef = visit.statusRef;
  const source = useCandidateReading(
    {
      candidate: 'concept-source',
      locale,
      address: [
        read?.public.subject.id,
        read?.public.subject.context,
        read?.public.subject.release,
        read?.public.subject.revision,
        read?.session,
      ],
    },
    admission,
  );
  const { FollowTarget } = useSearchLibraryActionHost();
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
    conceptVisit && conceptVisit.subject !== id ? conceptVisitHref(conceptVisit, locale, returnTo) : undefined;

  useLayoutEffect(() => {
    const current = routeIntentRef.current;
    if (current && current.key === routeAddressKey) {
      current.start();
    } else {
      current?.stop();
      if (current) previousRouteIntentRef.current = current;
      if (routeAddressKey) {
        routeIntentRef.current = watchPresentationIntent(
          routeAddressKey,
          visit.focus,
          read?.admitted && source.active ? source.generation : undefined,
        );
        previousRouteIntentRef.current = undefined;
      } else {
        routeIntentRef.current = undefined;
      }
    }
    return () => {
      const active = routeIntentRef.current;
      if (!active || active.key !== routeAddressKey) return;
      active.stop();
    };
  }, [routeAddressKey, visit.focus, read?.admitted, source.active, source.generation]);

  useLayoutEffect(
    () => () => {
      routeIntentRef.current?.stop();
      previousRouteIntentRef.current?.stop();
      noticeIntentRef.current?.stop();
    },
    [],
  );

  const addressFor = (focus: ConceptFocus) => {
    if (!read?.admitted) return;
    return conceptVisitAddressFor(read, visit.history, visit.index, worksRoute, focus, locale, returnTo);
  };
  const hierarchyHrefFor = (base: string, row: { id: string; conceptPage: boolean }) => {
    if (!read?.admitted) return base;
    if (!row.conceptPage) return subjectVisitHref(base, addressFor({ section: 'hierarchy', row: row.id }));
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
    if (!routeFocus) return;
    const intent = routeIntentRef.current;
    if (!intent || intent.consumed || !sameFocus(visit.focus, routeFocus) || visit.focus === intent.focusAtStart) return;
    if (intent.cancelled) {
      intent.consumed = true;
      intent.stop();
      return;
    }
    if (visit.loading || visit.busy || !read?.admitted || !source.active || !admission.active()) return;
    if (!currentAddressMatches(visit.history, visit.index, read, returnAddress)) return;
    if (intent.sourceGeneration === undefined) intent.sourceGeneration = source.generation;
    else if (intent.sourceGeneration !== source.generation) {
      intent.cancelled = true;
      intent.consumed = true;
      intent.stop();
      return;
    }
    if (
      routeFocus.section === 'hierarchy' &&
      visit.hierarchy?.state !== 'available' &&
      visit.hierarchy?.state !== 'lagging'
    )
      return;

    const article = articleRef.current;
    if (!article || !article.isConnected) return;
    const target = focusTargetFor(article, routeFocus);
    if (!target) {
      intent.consumed = true;
      intent.stop();
      if (
        focusRowMissingFor(article, routeFocus) &&
        read?.admitted &&
        source.active &&
        admission.active() &&
        currentAddressMatches(visit.history, visit.index, read, returnAddress) &&
        sameFocus(visit.focus, routeFocus)
      )
        reportFocusMissingRef.current();
      return;
    }
    if (
      intent.cancelled ||
      articleRef.current !== article ||
      !article ||
      !visibleArticleTarget(article, target) ||
      visit.loading ||
      visit.busy ||
      !read?.admitted ||
      !source.active ||
      !admission.active() ||
      intent.sourceGeneration !== source.generation ||
      !currentAddressMatches(visit.history, visit.index, read, returnAddress) ||
      !sameFocus(visit.focus, routeFocus)
    ) {
      intent.consumed = true;
      intent.stop();
      return;
    }
    intent.consumed = true;
    intent.stop();
    target.focus();
  }, [
    routeAddressKey,
    returnAddress,
    routeFocus?.section,
    routeFocus?.row,
    visit.focus,
    visit.loading,
    visit.busy,
    visit.completed,
    visit.history,
    visit.index,
    visit.hierarchy?.state,
    read,
    source.active,
    source.generation,
    admission.generation,
    admission.active,
  ]);

  const noticeKey = visit.notice ? JSON.stringify([visit.notice, visit.noticeSection ?? 'hierarchy']) : undefined;
  useLayoutEffect(() => {
    const current = noticeIntentRef.current;
    if (!noticeKey) {
      current?.stop();
      noticeIntentRef.current = undefined;
      return;
    }
    let intent = current;
    if (!intent || intent.key !== noticeKey) {
      intent?.stop();
      intent = watchPresentationIntent(noticeKey);
      noticeIntentRef.current = intent;
    } else {
      intent.start();
    }
    if (intent.consumed) return;
    if (intent.cancelled) {
      intent.consumed = true;
      intent.stop();
      return;
    }
    if (visit.loading || visit.busy || !read?.admitted) return;
    if (!admission.active() || !source.active) {
      if (!admission.active()) {
        intent.consumed = true;
        intent.stop();
      }
      return;
    }
    if (intent.sourceGeneration === undefined) intent.sourceGeneration = source.generation;
    else if (intent.sourceGeneration !== source.generation) {
      intent.consumed = true;
      intent.stop();
      return;
    }
    const cancelledReturn = routeIntentRef.current?.cancelled || previousRouteIntentRef.current?.cancelled;
    if (cancelledReturn) {
      intent.consumed = true;
      intent.stop();
      previousRouteIntentRef.current = undefined;
      return;
    }
    const article = articleRef.current;
    const heading = article ? noticeTargetFor(article, visit.noticeSection ?? 'hierarchy') : undefined;
    const status = statusRef.current;
    const target =
      article && heading && visibleArticleTarget(article, heading)
        ? heading
        : article && status && visibleArticleTarget(article, status)
          ? status
          : undefined;
    if (
      !target ||
      articleRef.current !== article ||
      !article ||
      !visibleArticleTarget(article, target) ||
      visit.loading ||
      visit.busy ||
      !read?.admitted ||
      !source.active ||
      !admission.active() ||
      intent.sourceGeneration !== source.generation ||
      noticeKey !== JSON.stringify([visit.notice, visit.noticeSection ?? 'hierarchy'])
    ) {
      intent.consumed = true;
      intent.stop();
      return;
    }
    intent.consumed = true;
    intent.stop();
    previousRouteIntentRef.current = undefined;
    target.focus();
  }, [
    routeAddressKey,
    noticeKey,
    visit.loading,
    visit.busy,
    visit.notice,
    visit.noticeSection,
    read,
    source.active,
    source.generation,
    statusRef,
    admission.generation,
    admission.active,
  ]);
  return (
    <article
      ref={articleRef}
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
          {read?.admitted && <FollowTarget targetId={read.public.subject.id} origin={followOrigin} />}
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
            onClick={() => (onHierarchyChange ? onHierarchyChange(undefined, { replace: true }) : void visit.restart())}
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
                <Input
                  className="font-mono"
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

              <ConceptMembershipReading
                membership={read.membership}
                locale={locale}
                hrefFor={(row) =>
                  subjectVisitHref(
                    subjectHref({ id: row.id, label: row.label }, locale).href,
                    addressFor({ section: 'works', row: row.id }),
                  )
                }
                busy={busy}
                onRetry={() => void visit.refresh()}
                onNext={(property) => void visit.membershipNext(property)}
                onPrevious={(property) => void visit.membershipPrevious(property)}
                indexFor={(property) => visit.membershipIndexFor(property)}
              />

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
