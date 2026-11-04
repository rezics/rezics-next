import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useMemo } from 'react';
import { defaultReader, type Reader } from '../../subject/reader';
import { useSession } from '../../session/query';
import { FollowTargetControl } from '../../library/follow-target-control';
import { ConceptAssociations, ConceptAliases } from './source-concept-reading/associations';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { ConceptRead } from '../catalogue/source-concept-explorer';
import {
  actionClass,
  linkClass,
  ConceptHierarchy,
  visitAnnouncement,
} from './source-concept-reading/hierarchy';
import { useConceptVisit, type ConceptTransport } from './source-concept-reading/visit';
import { originatingReturn } from './source-concept-reading/origin';
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
};

export function SourceConceptView(props: Props) {
  const admission = useCatalogueLifetime(JSON.stringify(['concept-explore', props.id, props.locale, props.role]));
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
}) {
  const o = { locale: locale as never };
  const returnTo = originatingReturn(suppliedReturn);
  const visit = useConceptVisit({ id, role, transport, initial, admission });
  const { read, error, busy } = visit;
  const source = useCatalogueLifetime(JSON.stringify([
    read?.public.subject.id, read?.public.subject.context, read?.public.subject.release,
    read?.public.subject.revision, read?.session,
  ]), admission);
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
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={visit.loading || busy}
    >
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 lang={title.lang ?? undefined} className="font-sans text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title.text || m.concept_explore_title({}, o)}</h1>
          {read?.admitted && <FollowTargetControl targetId={read.public.subject.id} origin={followOrigin} />}
        </div>
        {read?.definition && <p className="max-w-prose whitespace-pre-line" lang={read.definition.lang ?? undefined}>{read.definition.text}</p>}
        {read?.admitted && sessionState === 'signed-out' && <a className={linkClass}
          href={`/auth/sign-in?return_to=${encodeURIComponent(catalogueEntries.concepts({ id, label: title.text, locale }).href)}`}>
          {m.concept_visit_follow_sign_in({}, o)}
        </a>}
      </header>
      {pinUnsupported && <p role="status">{m.concept_explore_pin_unsupported({}, o)}</p>}
      <p ref={visit.statusRef} role="status" tabIndex={-1} aria-live="polite" aria-atomic="true">
        {visitAnnouncement(visit, locale)}
      </p>
      {error && (
        <div className="space-y-2">
          <p role="alert" tabIndex={-1}>
            {'oversized' in error && error.oversized ? m.concept_visit_oversized({}, o) : error.reason === 'denied' ? m.concept_explore_denied({}, o) : m.concept_explore_unreadable({}, o)}
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
              <label className="block">{m.concept_explore_identity({}, o)}
                <input className="block w-full font-mono" readOnly value={read.public.subject.id}
                  onFocus={(event) => event.currentTarget.select()} />
              </label>
              <p>{m.concept_explore_type({}, o)}: <code>{read.public.subject.type}</code></p>
              <p>{m.concept_explore_source_release({}, o)}: <code>{read.public.subject.release}</code></p>
              <p>{m.own_drafts_revision({}, o)}: {read.public.subject.revision}</p>
              <p>{m.prq_context({}, o)}: <code>{read.public.subject.context}</code></p>
            </details>
            {read.retired === true && <p role="status">{m.concept_explore_retired({}, o)}</p>}
            {read.retired === null && <p>{m.concept_explore_release_unknown({}, o)}</p>}
            {!read.admitted && <p role="status">{m.concept_explore_unsupported({}, o)}</p>}
            {pinUnsupported && <p>{m.concept_explore_pin_unsupported_detail({}, o)}</p>}
            {read.aliases.length > 0 && <section className="space-y-2">
              <h2 className="font-sans text-lg font-semibold">{m.concept_explore_aliases({}, o)}</h2>
              <ConceptAliases aliases={read.aliases} locale={locale} />
            </section>}
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
              <ConceptAssociations key={JSON.stringify([source.generation, reader, visit.completed])}
                read={read.public} codes={read.codes} locale={locale} reader={reader} returnTo={returnTo} />

              <ConceptHierarchy visit={visit} locale={locale} returnTo={returnTo} />

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
        <ConceptTaggedWorks
          read={read}
          locale={locale}
          route={{ ...(worksRoute ?? {}), role, returnTo }}
          onChange={onWorksChange}
        />
      )}
      {returnTo && (
        <a className={linkClass} href={returnTo}>
          {m.concept_explore_return({}, o)}
        </a>
      )}
    </article>
  );
}
