import { FilterError, parseFilter, type FilterDocument, type FilterQualifier } from '@rezics/filter';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../../session/query';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { subjectHref, type SubjectHrefInput } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { locales } from '../../../paraglide/runtime.js';
import { ConditionEditor } from '../../../search/condition-editor';
import { DiscoveryResults } from '../../../search/discovery-results';
import { useDiscoveryPersonalResults } from '../../../search/discovery-personal-host';
import { readDiscoveryPersonalPage } from '../../../search/discovery-personal-server';
import { localizedLabel } from '../../../search/results';
import { catalogueEntries } from '../catalogue-entry';
import type { ConceptRead } from '../source-concept-explorer';
import { subjectVisitHref } from '../../pages/source-concept-reading/navigation';
import {
  boundedConceptWorksState,
  conceptWorksExactEmpty,
  conceptWorksRequest,
  publicConceptWorksState,
  type ConceptWorksSelection,
} from './index';
import { readPublicConceptWorks } from './actions';
import type { DiscoveryRequest, DiscoveryState } from '../../../search/discovery';

export type ConceptWorksRouteState = {
  role?: string | undefined;
  returnTo?: string | undefined;
  property?: string | undefined;
  scheme?: string | undefined;
  type?: string | undefined;
  includeChildren?: boolean | undefined;
  spoilerThreshold?: 0 | 1 | 2 | undefined;
  conditionText?: string | undefined;
  tagQualifiersText?: string | undefined;
  cursor?: string | undefined;
  invalid?: boolean | undefined;
};

export type ConceptWorksRoutePatch = {
  [Key in 'property' | 'scheme' | 'type' | 'includeChildren' | 'spoilerThreshold' | 'cursor' | 'tagQualifiersText']?:
    | ConceptWorksRouteState[Key]
    | undefined;
} & { condition?: FilterDocument | undefined };

type Props = {
  read: Extract<ConceptRead, { ok: true }>;
  locale: string;
  route: ConceptWorksRouteState;
  onChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
  conceptReturnForResult?: ((subject: SubjectHrefInput) => string | undefined) | undefined;
};

const loading: DiscoveryState = { status: 'loading' };

function requestCondition(value: string | undefined): FilterDocument | undefined {
  if (!value) return;
  try {
    return parseFilter(JSON.parse(value));
  } catch (error) {
    if (error instanceof FilterError) return;
    return;
  }
}

function requestQualifiers(value: string | undefined): readonly FilterQualifier[] | undefined {
  if (!value) return;
  try {
    const parsed = parseFilter({
      statement: { property: 'rezics:conceptTag', in: ['x'], qualifiers: JSON.parse(value) },
    });
    return 'statement' in parsed ? parsed.statement.qualifiers : undefined;
  } catch {
    return;
  }
}

function routeHref(id: string, label: string, locale: string, route: ConceptWorksRouteState, includeCursor: boolean) {
  const base = catalogueEntries.concepts({ id, label, locale }).href;
  const search = new URLSearchParams();
  if (route.role) search.set('role', route.role);
  if (route.returnTo) search.set('returnTo', route.returnTo);
  if (route.property) search.set('property', route.property);
  if (route.scheme) search.set('scheme', route.scheme);
  if (route.type) search.set('type', route.type);
  if (route.includeChildren) search.set('children', 'true');
  if (route.spoilerThreshold !== undefined && route.spoilerThreshold !== 0)
    search.set('spoiler', String(route.spoilerThreshold));
  if (route.conditionText) search.set('condition', route.conditionText);
  if (route.tagQualifiersText) search.set('tagQualifiers', route.tagQualifiersText);
  if (includeCursor && route.cursor) search.set('cursor', route.cursor);
  return `${base}${search.size ? `?${search}` : ''}`;
}

function asDiscoveryState(
  value: DiscoveryState | { status: 'unsupported' | 'unavailable' | 'denied' },
): DiscoveryState {
  return value;
}

function privatePageWithinLimit(result: Awaited<ReturnType<typeof readDiscoveryPersonalPage>>) {
  const state = boundedConceptWorksState(result.state);
  try {
    if (state === result.state && new TextEncoder().encode(JSON.stringify(result)).byteLength <= 65_536) return result;
  } catch {
    // Strip viewer material below while retaining any independently bounded public cards.
  }
  return {
    ...result,
    state: boundedConceptWorksState(publicConceptWorksState(result.state)),
    capabilities: null,
  };
}

function ConceptWorksVisit({
  read,
  locale,
  route,
  onChange,
  request,
  selectionKey,
  selection,
}: Props & {
  request: DiscoveryRequest | undefined;
  selectionKey: string;
  selection: ConceptWorksSelection | undefined;
}) {
  const session = useSession();
  const signedOut = session.state === 'signed-out';
  const [publicState, setPublicState] = useState<DiscoveryState>(loading);
  const [retryNumber, setRetryNumber] = useState(0);
  const [lastReady, setLastReady] = useState<DiscoveryState>();
  const requestKey = JSON.stringify(request);
  const cursor = route.cursor;
  const publicRead = useRef(0);
  const publicLoad = readPublicConceptWorks;

  useEffect(() => {
    if (!signedOut || !request) {
      setPublicState(loading);
      return;
    }
    const readId = ++publicRead.current;
    setPublicState(loading);
    if (!selection) return;
    void publicLoad({ data: { request, locale } })
      .then((result) => {
        if (publicRead.current !== readId) return;
        const state = boundedConceptWorksState(asDiscoveryState(result));
        setPublicState(state);
        if (state.status === 'ready') setLastReady(publicConceptWorksState(state));
      })
      .catch(() => {
        if (publicRead.current === readId) setPublicState({ status: 'unavailable' });
      });
    return () => {
      publicRead.current++;
    };
  }, [signedOut, requestKey, retryNumber, locale, selection]);

  const privateSource = useMemo<DiscoveryState>(() => ({ status: 'loading' }), [selectionKey, requestKey, retryNumber]);
  const personal = useDiscoveryPersonalResults({
    source: signedOut ? publicState : privateSource,
    request,
    locale,
    returnTo: routeHref(read.public.subject.id, read.public.subject.labels[locale] ?? '', locale, route, false),
    enabled: session.state === 'signed-in',
    read: async (options) => privatePageWithinLimit(await readDiscoveryPersonalPage(options)),
  });
  const current = signedOut ? publicState : session.state === 'signed-in' ? (personal.state ?? loading) : loading;

  useEffect(() => {
    if (!signedOut && current.status === 'ready') setLastReady(publicConceptWorksState(current));
  }, [signedOut, current]);

  const continuationFailure =
    !!cursor && (current.status === 'unavailable' || current.status === 'closed') && lastReady?.status === 'ready';
  const source = continuationFailure ? lastReady! : current;
  const stalePublic = continuationFailure ? publicConceptWorksState(source) : source;
  const exactEmpty = conceptWorksExactEmpty(source);
  const partialEmpty = source.status === 'ready' && source.page.hits.length === 0 && !exactEmpty;
  const display: DiscoveryState = partialEmpty
    ? { status: source.page.freshness?.state === 'unavailable' ? 'unavailable' : 'preparing' }
    : stalePublic;
  const page = source.status === 'ready' ? source.page : undefined;
  const noSelection = !request && !route.invalid;
  const invalid = route.invalid || (!request && (!!route.conditionText || !!route.tagQualifiersText));
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const title = read.public.subject.labels[locale] ?? read.public.subject.id;
  const restartHref = routeHref(read.public.subject.id, title, locale, route, false);

  return (
    <section
      className="space-y-4"
      aria-labelledby="concept-tagged-works-heading"
      aria-busy={display.status === 'loading'}
    >
      <h2 id="concept-tagged-works-heading" className="font-sans text-xl font-semibold">
        {m.concept_tagged_works_title({}, options)}
      </h2>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="concept-work-property">{m.concept_tagged_works_property({}, options)}</FieldLabel>
          <NativeSelect
            id="concept-work-property"
            value={
              route.property ??
              (read.requestedRole && read.works?.properties.some((entry) => entry.id === read.requestedRole)
                ? read.requestedRole
                : '')
            }
            onChange={(event) =>
              onChange?.({
                property: event.currentTarget.value || undefined,
                type: undefined,
                cursor: undefined,
                tagQualifiersText: undefined,
              })
            }
          >
            <NativeSelectOption value="">{m.concept_tagged_works_choose({}, options)}</NativeSelectOption>
            {read.works?.state === 'available' &&
              read.works.properties.map((property) => (
                <NativeSelectOption key={property.id} value={property.id}>
                  {localizedLabel(property.labels, locale).text.trim() || property.id}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="concept-work-scheme">{m.concept_tagged_works_scheme({}, options)}</FieldLabel>
          <NativeSelect
            id="concept-work-scheme"
            value={route.scheme ?? ''}
            onChange={(event) => onChange?.({ scheme: event.currentTarget.value || undefined, cursor: undefined })}
          >
            <NativeSelectOption value="">{m.concept_tagged_works_choose({}, options)}</NativeSelectOption>
            {read.schemes
              .filter((scheme) => scheme.readable && scheme.conceptPage)
              .map((scheme) => (
                <NativeSelectOption key={scheme.id} value={scheme.id}>
                  {scheme.label || scheme.id}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="concept-work-type">{m.concept_tagged_works_type({}, options)}</FieldLabel>
          <NativeSelect
            id="concept-work-type"
            value={route.type ?? ''}
            disabled={!route.property && !read.requestedRole}
            onChange={(event) => onChange?.({ type: event.currentTarget.value || undefined, cursor: undefined })}
          >
            <NativeSelectOption value="">{m.search_all_subject_types({}, options)}</NativeSelectOption>
            {read.works?.state === 'available' &&
              read.works.types
                .filter((type) => {
                  const propertyId = route.property ?? read.requestedRole;
                  return (
                    !propertyId ||
                    read.works?.properties.find((entry) => entry.id === propertyId)?.types.includes(type.id)
                  );
                })
                .map((type) => (
                  <NativeSelectOption key={type.id} value={type.id}>
                    {localizedLabel(type.labels, locale).text.trim() || type.id}
                  </NativeSelectOption>
                ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="concept-work-spoiler">{m.concept_tagged_works_spoiler({}, options)}</FieldLabel>
          <NativeSelect
            id="concept-work-spoiler"
            value={String(route.spoilerThreshold ?? 0)}
            onChange={(event) =>
              onChange?.({ spoilerThreshold: Number(event.currentTarget.value) as 0 | 1 | 2, cursor: undefined })
            }
          >
            <NativeSelectOption value="0">{m.character_person_threshold_0({}, options)}</NativeSelectOption>
            <NativeSelectOption value="1">{m.character_person_threshold_1({}, options)}</NativeSelectOption>
            <NativeSelectOption value="2">{m.character_person_threshold_2({}, options)}</NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm" htmlFor="concept-work-descendants">
        <input
          id="concept-work-descendants"
          type="checkbox"
          checked={route.includeChildren ?? false}
          onChange={(event) => onChange?.({ includeChildren: event.currentTarget.checked, cursor: undefined })}
        />
        {m.concept_tagged_works_descendants({}, options)}
      </label>

      {read.works?.state === 'available' && roleAvailableForRoute(read, route) && route.scheme && (
        <details className="rounded-lg border border-border/60 p-3" open={!!route.conditionText}>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            {m.concept_tagged_works_additional({}, options)}
          </summary>
          <ConditionEditor
            value={requestCondition(route.conditionText)}
            onChange={(condition) => onChange?.({ condition, cursor: undefined })}
            metadata={read.works.metadata}
            locale={locale}
            embedded
          />
        </details>
      )}

      {read.works?.state !== 'available' ? (
        <div className="space-y-2">
          <p role="status">{m.discovery_unsupported({}, options)}</p>
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`${catalogueEntries.facts({ id: read.public.subject.id, label: title, locale }).href}${route.returnTo ? `?${new URLSearchParams({ returnTo: route.returnTo })}` : ''}`}
          >
            {m.concept_tagged_works_source({}, options)}
          </a>
        </div>
      ) : invalid ? (
        <div role="alert" aria-describedby="concept-works-invalid-summary">
          <p id="concept-works-invalid-summary">{m.concept_tagged_works_invalid({}, options)}</p>
          <DiscoveryResults state={{ status: 'invalid' }} locale={locale} restartHref={restartHref} />
        </div>
      ) : noSelection ? (
        <DiscoveryResults state={{ status: 'unsupported' }} locale={locale} />
      ) : (
        <div
          ref={(element) => {
            personal.regionRef.current = element;
          }}
          className="space-y-3"
          data-slot="concept-tagged-works-results"
        >
          {continuationFailure && (
            <div role="alert" tabIndex={-1} className="space-y-2">
              <p>{m.concept_tagged_works_continuation_failed({}, options)}</p>
              <Button type="button" variant="outline" onClick={() => setRetryNumber((value) => value + 1)}>
                {m.concept_tagged_works_retry({}, options)}
              </Button>
            </div>
          )}
          {partialEmpty && <p role="status">{m.concept_tagged_works_lagging({}, options)}</p>}
          {source.status === 'ready' && source.page.hits.length > 0 && source.page.freshness?.state !== 'current' && (
            <p role="status">{m.concept_tagged_works_lagging({}, options)}</p>
          )}
          <DiscoveryResults
            state={display}
            locale={locale}
            restartHref={restartHref}
            renderPersonal={personal.renderPersonal}
            subjectHrefFor={(subject: SubjectHrefInput) => {
              const returnAddress =
                props.conceptReturnForResult?.(subject) ?? routeHref(read.public.subject.id, title, locale, route, false);
              return subjectVisitHref(subjectHref(subject, locale).href, returnAddress);
            }}
          />
          {page?.next && !continuationFailure && (
            <Button
              type="button"
              variant="outline"
              disabled={display.status !== 'ready'}
              onClick={() => onChange?.({ cursor: page.next ?? undefined })}
            >
              {m.concept_tagged_works_next({}, options)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function roleAvailableForRoute(read: Extract<ConceptRead, { ok: true }>, route: ConceptWorksRouteState) {
  const property = route.property ?? read.requestedRole;
  return read.works?.state === 'available' && read.works.properties.some((entry) => entry.id === property);
}

export function ConceptTaggedWorks(props: Props) {
  const session = useSession();
  const admission = props.read.works;
  const role = props.route.property ?? props.read.requestedRole ?? undefined;
  const roleAvailable = admission?.state === 'available' && admission.properties.some((entry) => entry.id === role);
  const schemeOptions = props.read.schemes.filter((scheme) => scheme.readable && scheme.conceptPage);
  const uniqueScheme = props.read.schemes.length === 1 && schemeOptions.length === 1 ? schemeOptions[0] : undefined;
  const scheme = props.route.scheme ?? uniqueScheme?.id;
  useEffect(() => {
    if (uniqueScheme && !props.route.scheme)
      props.onChange?.({ scheme: uniqueScheme.id, cursor: undefined }, { replace: true });
  }, [uniqueScheme?.id, props.route.scheme, props.onChange]);
  const condition = useMemo(() => requestCondition(props.route.conditionText), [props.route.conditionText]);
  const qualifiers = useMemo(() => requestQualifiers(props.route.tagQualifiersText), [props.route.tagQualifiersText]);
  const search = useMemo<ConceptWorksSelection>(
    () => ({
      conceptId: props.read.public.subject.id,
      ...(roleAvailable && role ? { property: role } : {}),
      ...(scheme ? { scheme } : {}),
      ...(props.route.type ? { type: props.route.type } : {}),
      ...(props.route.includeChildren ? { includeChildren: true } : {}),
      spoilerThreshold: props.route.spoilerThreshold ?? 0,
      ...(qualifiers ? { qualifiers } : {}),
      ...(condition ? { condition } : {}),
      ...(props.route.cursor ? { cursor: props.route.cursor } : {}),
    }),
    [
      props.read.public.subject.id,
      roleAvailable,
      role,
      scheme,
      props.route.type,
      props.route.includeChildren,
      props.route.spoilerThreshold,
      qualifiers,
      condition,
      props.route.cursor,
    ],
  );
  const request = useMemo(
    () =>
      props.route.invalid ||
      (!!props.route.conditionText && !condition) ||
      (!!props.route.tagQualifiersText && !qualifiers)
        ? undefined
        : conceptWorksRequest(search, admission, props.read.schemes, props.locale),
    [
      props.route.invalid,
      props.route.conditionText,
      props.route.tagQualifiersText,
      condition,
      qualifiers,
      search,
      admission,
      props.read.schemes,
      props.locale,
    ],
  );
  const selectionKey = JSON.stringify([
    props.read.public.subject.id,
    props.read.public.subject.release,
    props.read.public.subject.revision,
    props.read.public.subject.context,
    props.read.session,
    props.locale,
    role,
    scheme,
    props.route.type,
    props.route.includeChildren,
    props.route.spoilerThreshold,
    props.route.conditionText,
    props.route.tagQualifiersText,
    props.route.returnTo,
    session.state,
    session.subject,
    session.csrfToken,
  ]);
  const lifetime = useCatalogueLifetime(selectionKey);
  const route = { ...props.route, ...(scheme ? { scheme } : {}) };
  return (
    <ConceptWorksVisit
      key={lifetime.generation}
      {...props}
      route={route}
      request={request}
      selectionKey={selectionKey}
      selection={search.property && search.scheme ? search : undefined}
      onChange={props.onChange}
    />
  );
}
