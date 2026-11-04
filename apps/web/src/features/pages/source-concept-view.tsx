import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { ConceptRead } from '../catalogue/source-concept-explorer';
import {
  actionClass,
  linkClass,
  HierarchyLinks,
  ConceptHierarchy,
  visitAnnouncement,
} from './source-concept-reading/hierarchy';
import { useConceptVisit, type ConceptTransport } from './source-concept-reading/visit';
import { originatingConceptReturn } from './source-concept-reading/origin';
import {
  ConceptTaggedWorks,
  type ConceptWorksRoutePatch,
  type ConceptWorksRouteState,
} from '../catalogue/concept-works/view';
import { ViewHeading } from './view-heading';

export type { ConceptTransport } from './source-concept-reading/visit';

type Props = {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean;
  transport: ConceptTransport;
  initial?: ConceptRead | undefined;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
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
  admission: ReturnType<typeof useCatalogueLifetime>;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
}) {
  const o = { locale: locale as never };
  const returnTo = originatingConceptReturn(suppliedReturn, locale);
  const visit = useConceptVisit({ id, role, transport, initial, admission });
  const { read, error, busy } = visit;
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
      <ViewHeading label={m.concept_explore_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.concept_explore_intro({}, o)}</p>
      {pinUnsupported && <p role="status">{m.concept_explore_pin_unsupported({}, o)}</p>}
      <p ref={visit.statusRef} role="status" tabIndex={-1} aria-live="polite" aria-atomic="true">
        {visitAnnouncement(visit, locale)}
      </p>
      {error && (
        <div className="space-y-2">
          <p role="alert" tabIndex={-1}>
            {error.reason === 'denied' ? m.concept_explore_denied({}, o) : m.concept_explore_unreadable({}, o)}
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
            <h2 className="font-sans text-lg font-semibold" lang={title.lang ?? undefined}>
              {title.text || id}
            </h2>
            <p>
              {m.concept_explore_identity({}, o)}: <code>{read.public.subject.id}</code>
            </p>
            <p>
              {m.concept_explore_type({}, o)}: <code>{read.public.subject.type}</code>
            </p>
            <p>
              {m.concept_explore_source_release({}, o)}: <code>{read.public.subject.release}</code>
            </p>
            {read.retired === true && <p role="status">{m.concept_explore_retired({}, o)}</p>}
            {read.retired === null && <p>{m.concept_explore_release_unknown({}, o)}</p>}
            {!read.admitted && <p role="status">{m.concept_explore_unsupported({}, o)}</p>}
            {pinUnsupported && <p>{m.concept_explore_pin_unsupported_detail({}, o)}</p>}
            {read.spoiler && <p role="status">{m.concept_explore_spoiler({}, o)}</p>}
            {read.definition && (
              <p lang={read.definition.lang ?? undefined}>
                <strong>{m.concept_explore_definition({}, o)}:</strong> {read.definition.text}
              </p>
            )}
            {read.aliases.length > 0 && (
              <p>
                <strong>{m.concept_explore_aliases({}, o)}:</strong>{' '}
                {read.aliases.map((alias, index) => (
                  <span key={`${alias.lang}:${alias.text}`} lang={alias.lang ?? undefined}>
                    {index ? ' · ' : ''}
                    {alias.text}
                  </span>
                ))}
              </p>
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
              <section className="space-y-2">
                <h2 className="font-sans text-lg font-semibold">{m.concept_explore_scheme({}, o)}</h2>
                {read.schemes.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {read.schemes.map((scheme) => (
                      <li key={scheme.id}>
                        {scheme.readable && scheme.conceptPage ? (
                          <a
                            className={linkClass}
                            href={`${catalogueEntries.concepts({ id: scheme.id, label: scheme.label, locale }).href}${
                              returnTo ? `?${new URLSearchParams({ returnTo })}` : ''
                            }`}
                            lang={scheme.lang ?? undefined}
                          >
                            {scheme.label || scheme.id}
                          </a>
                        ) : scheme.readable ? (
                          <a
                            className={linkClass}
                            href={`${subjectHref({ id: scheme.id, label: scheme.label }, locale).href}${
                              returnTo ? `?${new URLSearchParams({ returnTo })}` : ''
                            }`}
                          >
                            {scheme.label || scheme.id}
                          </a>
                        ) : (
                          <span>{m.concept_explore_scheme_withheld({}, o)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.concept_explore_no_schemes({}, o)}</p>
                )}
              </section>

              <section className="space-y-2">
                <h2 className="font-sans text-lg font-semibold">{m.concept_explore_source_code({}, o)}</h2>
                {read.codes.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {read.codes.map((code) => (
                      <li key={`${code.property}:${code.value}`}>
                        <span lang={code.labelLang ?? undefined}>{code.label}</span> <code>{code.property}</code>:{' '}
                        <code>{code.value}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.concept_explore_no_codes({}, o)}</p>
                )}
              </section>

              <section className="space-y-2" aria-labelledby="concept-broader-heading">
                <h2 id="concept-broader-heading" className="font-sans text-lg font-semibold">
                  {m.concept_explore_broader({}, o)}
                </h2>
                {read.broader.rows.length ? (
                  <HierarchyLinks
                    rows={read.broader.rows}
                    locale={locale}
                    {...(returnTo === undefined ? {} : { returnTo })}
                  />
                ) : read.broader.withheld ? (
                  <p role="status">{m.concept_explore_broader_withheld({}, o)}</p>
                ) : (
                  <p>{m.concept_explore_no_broader({}, o)}</p>
                )}
                {!!read.broader.rows.length && read.broader.withheld > 0 && (
                  <p role="status">{m.concept_explore_broader_withheld({}, o)}</p>
                )}
              </section>

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
