import { useQuery } from '@tanstack/react-query';
import type { PropertyDefinition } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { cn } from '@rezics/ui/utils';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { unitSymbols } from './statement-editor';
import { DefinitionMeaning as Meaning } from './definition-meaning';
import {
  definitionGuideHref,
  definitionText,
  guideIdentifierLimit,
  guideReturnTo,
  guideTypes,
  type GuideLocale,
  type GuideAddress,
  type GuideRead,
  type GuideRelease,
  type GuideTransport,
} from './definition-guide';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const recoveryClassName = 'rounded-sm focus:outline-2 focus:outline-offset-4 focus:outline-ring';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
// Keep native summary display and its disclosure marker, including keyboard activation.
const summaryClassName =
  'min-h-11 min-w-11 max-w-full cursor-pointer whitespace-normal rounded-sm py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-0 md:pointer-fine:py-0';

type GuideFocusIntent = {
  opener: HTMLElement;
  scope: string;
  cancelled: boolean;
  action?: 'retry' | 'directory' | 'type';
  identity?: string;
  token?: object;
};

type GuideFocusRef = { current: GuideFocusIntent | undefined };

function useGuideFocusIntent() {
  const intent = useRef<GuideFocusIntent>();
  useEffect(() => {
    const retireOnPointer = (event: PointerEvent) => {
      const current = intent.current;
      if (current && !current.opener.contains(event.target as Node)) current.cancelled = true;
    };
    const retireOnFocus = (event: globalThis.FocusEvent) => {
      const current = intent.current;
      if (!current || event.target === current.opener) return;
      if (
        event.target === document.body &&
        (!current.opener.isConnected || (current.opener instanceof HTMLButtonElement && current.opener.disabled))
      )
        return;
      current.cancelled = true;
    };
    document.addEventListener('pointerdown', retireOnPointer, true);
    document.addEventListener('focusin', retireOnFocus, true);
    return () => {
      document.removeEventListener('pointerdown', retireOnPointer, true);
      document.removeEventListener('focusin', retireOnFocus, true);
    };
  }, []);
  return intent;
}

function armGuideFocusIntent(
  intent: GuideFocusRef,
  event: KeyboardEvent<HTMLElement>,
  scope: string,
) {
  if (event.defaultPrevented || event.repeat) return;
  if (event.key !== 'Enter' && !(event.key === ' ' && event.currentTarget instanceof HTMLButtonElement)) return;
  intent.current = { opener: event.currentTarget, scope, cancelled: false };
}

function takeGuideFocusIntent(
  intent: GuideFocusRef,
  event: MouseEvent<HTMLElement>,
  scope: string,
) {
  const current = intent.current;
  if (!current) return undefined;
  if (event.detail !== 0 || current.opener !== event.currentTarget || current.scope !== scope || current.cancelled) {
    intent.current = undefined;
    return undefined;
  }
  return current;
}

function cancelGuideFocusIntentOnBlur(intent: GuideFocusRef, event: FocusEvent<HTMLElement>) {
  const current = intent.current;
  if (!current || current.opener !== event.currentTarget || !event.currentTarget.isConnected) return;
  const next = event.relatedTarget as HTMLElement | null;
  if (
    (next === null || next === document.body) &&
    current.opener instanceof HTMLButtonElement &&
    current.opener.disabled
  )
    return;
  current.cancelled = true;
}

function finishGuideFocusIntent(
  intentRef: GuideFocusRef,
  intent: GuideFocusIntent,
  target: HTMLElement | null,
) {
  if (intentRef.current === intent) intentRef.current = undefined;
  if (intent.cancelled) return;
  if (intent.opener.isConnected) {
    if (
      document.activeElement === document.body &&
      !(intent.opener instanceof HTMLButtonElement && intent.opener.disabled)
    )
      intent.opener.focus();
    return;
  }
  target?.focus();
}

function guideRecoveryTarget(root: HTMLElement | null) {
  return (
    root?.querySelector<HTMLElement>('h3[data-guide-recovery]') ??
    root?.querySelector<HTMLElement>('h2[data-guide-recovery]') ??
    root?.querySelector<HTMLElement>('[data-guide-recovery]') ??
    root?.querySelector<HTMLElement>('h1') ??
    null
  );
}

function Kind({ datatype, locale }: { datatype: string; locale: string }) {
  const o = { locale: locale as never };
  const labels: Record<string, () => string> = {
    string: () => m.guide_string({}, o),
    'external-id': () => m.guide_code({}, o),
    url: () => m.guide_url({}, o),
    monolingualtext: () => m.guide_language_text({}, o),
    quantity: () => m.guide_quantity({}, o),
    time: () => m.guide_date({}, o),
    'wikibase-item': () => m.guide_subject({}, o),
    document: () => m.guide_document({}, o),
    media: () => m.guide_media({}, o),
  };
  return labels[datatype]?.() ?? m.guide_missing({}, o);
}

function Constraint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 max-w-full [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Inert emitted constraints, including qualifier definitions; no schema execution or related-subject fetches. */
function Constraints({
  definition,
  release,
  locale,
  qualifiers = true,
}: {
  definition: PropertyDefinition;
  release: GuideRelease;
  locale: string;
  qualifiers?: boolean;
}) {
  const o = { locale: locale as never };
  const value = object(definition.value);
  const parts = object(value.properties);
  const amount = object(parts.amount);
  const text = definition.datatype === 'monolingualtext' ? object(parts.text) : value;
  const pattern = typeof text.pattern === 'string' ? text.pattern : undefined;
  const precision = object(parts.precision).enum;
  const calendar = object(parts.calendarmodel).const;
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Constraint label={m.guide_datatype({}, o)}>
          <Kind datatype={definition.datatype} locale={locale} />
        </Constraint>
        <Constraint label={m.guide_cardinality({}, o)}>
          {definition.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
        </Constraint>
        {definition.targets && (
          <Constraint label={m.guide_targets({}, o)}>
            <ul className="space-y-1">
              {definition.targets.map((target) => (
                <li key={target}>
                  <Meaning values={release.types[target]?.labels} locale={locale} />
                  {!definitionText(release.types[target]?.labels, locale).text && (
                    <details className="text-sm">
                      <summary className={summaryClassName}>{m.guide_identifier({}, o)}</summary>
                      <code className="break-all">{target}</code>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Constraint>
        )}
        {definition.units && (
          <Constraint label={m.guide_units({}, o)}>
            <ul>
              {definition.units.map((unit) => (
                <li key={unit}>
                  {unit === '1'
                    ? m.correction_unitless({}, o)
                    : unit === '*'
                      ? m.guide_any_unit({}, o)
                      : (unitSymbols[unit] ?? m.guide_unknown_unit({}, o))}
                  {unit !== '1' && unit !== '*' && (
                    <details className="text-sm text-muted-foreground">
                      <summary className={summaryClassName}>{m.guide_identifier({}, o)}</summary>
                      <code className="break-all">{unit}</code>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Constraint>
        )}
        {definition.minimum !== undefined && (
          <Constraint label={m.guide_minimum({}, o)}>{definition.minimum}</Constraint>
        )}
        {definition.maximum !== undefined && (
          <Constraint label={m.guide_maximum({}, o)}>{definition.maximum}</Constraint>
        )}
        {definition.datatype === 'quantity' && (
          <Constraint label={m.guide_format({}, o)}>
            <p>{amount.pattern === '^[+-](?:0|[1-9][0-9]*)$' ? m.guide_integer({}, o) : m.guide_decimal({}, o)}</p>
            <p>
              {parts.lowerBound === undefined && parts.upperBound === undefined
                ? m.guide_exact({}, o)
                : m.guide_bounds({}, o)}
            </p>
          </Constraint>
        )}
        {definition.datatype === 'time' && Array.isArray(precision) && (
          <Constraint label={m.correction_precision({}, o)}>
            {precision
              .map((p) =>
                p === 9
                  ? m.correction_year({}, o)
                  : p === 10
                    ? m.correction_month({}, o)
                    : p === 11
                      ? m.correction_day({}, o)
                      : m.guide_missing({}, o),
              )
              .join(' · ')}
            {calendar === 'http://www.wikidata.org/entity/Q1985727' && <p>{m.correction_calendar({}, o)}</p>}
          </Constraint>
        )}
        {pattern && (
          <Constraint label={m.guide_format({}, o)}>
            <code className="break-all text-sm">{pattern}</code>
          </Constraint>
        )}
      </dl>
      {qualifiers && (
        <section className="flex min-w-0 flex-col gap-3">
          <ContentItemHeading level={3} className="font-medium">
            {m.guide_qualifiers({}, o)}
          </ContentItemHeading>
          {definition.qualifiers.length === 0 ? (
            <p className="text-muted-foreground">{m.guide_no_qualifiers({}, o)}</p>
          ) : (
            definition.qualifiers.map((id) => {
              const qualifier = release.properties[id];
              return (
                <ContentItemFrame key={id} as="div" className="min-w-0 p-3">
                  <details className="min-w-0">
                    <summary className={summaryClassName}>
                      {qualifier ? <Meaning values={qualifier.labels} locale={locale} /> : <code>{id}</code>}
                    </summary>
                    {qualifier && (
                      <div className="mt-3 space-y-3">
                        <Meaning values={qualifier.descriptions} locale={locale} />
                        <Constraints definition={qualifier} release={release} locale={locale} qualifiers={false} />
                      </div>
                    )}
                  </details>
                </ContentItemFrame>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}

/** A read-only companion to the native editors, sharing the ordinary shell and controls. */
export function DefinitionGuide({
  address,
  locale,
  transport,
  initial,
}: {
  address: GuideAddress;
  locale: string;
  transport: GuideTransport;
  initial?: GuideRead;
}) {
  const query = useQuery({
    queryKey: ['definition-guide', address, locale],
    queryFn: () => transport.read(locale as GuideLocale),
    initialData: initial,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: initial === undefined,
  });
  // Retire callbacks as well as focus intent when this query address leaves.
  // A later visit to an equal address must not revive an earlier attempt.
  const key = JSON.stringify([address.type, address.property, address.release, address.returnTo, locale]);
  const lifetime = useRef({ key, active: true, pending: false });
  if (lifetime.current.key !== key) {
    lifetime.current.active = false;
    lifetime.current = { key, active: true, pending: false };
  }
  const owner = lifetime.current;
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const [attempt, setAttempt] = useState<{
    owner: typeof owner;
    pending: boolean;
    completion?: { token: object; intent?: GuideFocusIntent };
  }>({
    owner,
    pending: false,
  });
  const current = attempt.owner === owner ? attempt : undefined;
  const retry = (intent?: GuideFocusIntent) => {
    if (!owner.active || owner.pending || query.isFetching) return false;
    owner.pending = true;
    setAttempt({ owner, pending: true });
    // Coalesce an already running shared read rather than cancelling/replacing it.
    void query.refetch({ cancelRefetch: false }).then(() => {
      if (!owner.active) return;
      owner.pending = false;
      setAttempt({ owner, pending: false, completion: { token: {}, ...(intent ? { intent } : {}) } });
    });
    return true;
  };
  const read: GuideRead | undefined = query.isError ? { ok: false, reason: 'unavailable' } : query.data;
  return (
    <DefinitionGuideContent
      address={address}
      locale={locale}
      transport={transport}
      read={read}
      retry={retry}
      retryPending={current?.pending || query.isFetching}
      retryCompletion={current?.completion}
    />
  );
}

function ActiveGuide({
  address,
  locale,
  initial,
  transport,
}: {
  address: GuideAddress;
  locale: string;
  initial?: GuideRead | undefined;
  transport: GuideTransport;
}) {
  const o = { locale: locale as never };
  const prefixId = useId();
  const exactId = useId();
  const key = JSON.stringify([address.type, address.property, address.release, address.returnTo, locale]);
  const section = useRef<HTMLElement>(null);
  const focusIntent = useGuideFocusIntent();
  const handledFocus = useRef<object | undefined>(undefined);
  const [focusCompletion, setFocusCompletion] = useState<
    { token: object; intent: GuideFocusIntent } | undefined
  >();
  if (focusIntent.current && focusIntent.current.scope !== key) focusIntent.current = undefined;
  const [search, setSearch] = useState({
    draft: '',
    query: '',
    cursor: undefined as string | undefined,
    active: false,
  });
  const [selection, setSelection] = useState({ key, type: address.type ?? '', requested: false, attempt: 0 });
  const [searchExactDraft, setSearchExactDraft] = useState(address.type ?? '');
  const currentSelection =
    selection.key === key ? selection : { key, type: address.type ?? '', requested: false, attempt: 0 };
  if (selection.key !== key) setSelection(currentSelection);

  const pageQuery = useQuery({
    queryKey: ['definition-guide-directory', locale, search.query, search.cursor ?? null],
    queryFn: () => transport.directory(locale as GuideLocale, search.query, search.cursor),
    enabled: search.active,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
  const typeQuery = useQuery({
    queryKey: ['definition-guide-type', locale, currentSelection.type, currentSelection.attempt],
    queryFn: () => transport.exact(locale as GuideLocale, currentSelection.type),
    enabled: currentSelection.requested && currentSelection.type.length > 0,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  const initialPage = initial?.ok && initial.pin === 'active' && 'page' in initial ? initial.page : undefined;
  const pageRead = search.active ? pageQuery.data : initialPage ? { ok: true as const, page: initialPage } : undefined;
  const initialDescriptor =
    !currentSelection.requested &&
    initial?.ok &&
    initial.pin === 'active' &&
    'descriptor' in initial &&
    initial.descriptor.typeId === currentSelection.type
      ? { ok: true as const, descriptor: initial.descriptor }
      : undefined;
  const selectedRead = currentSelection.requested ? typeQuery.data : initialDescriptor;
  const descriptor = selectedRead?.ok ? selectedRead.descriptor : undefined;
  const release: GuideRelease | undefined = descriptor
    ? {
        digest: descriptor.releaseDigest,
        types: { [descriptor.typeId]: descriptor.definition },
        properties: descriptor.properties,
      }
    : undefined;
  const type = descriptor?.definition;
  const property = currentSelection.type === address.type ? address.property : undefined;
  const field =
    property && type?.properties.includes(property) && release && Object.hasOwn(release.properties, property)
      ? release.properties[property]
      : undefined;
  const page = pageRead?.ok ? pageRead.page : undefined;
  const query = search.active ? search.query : '';
  const retireFocusIntent = () => {
    focusIntent.current = undefined;
    setFocusCompletion(undefined);
  };
  const runFocusAction = (
    event: MouseEvent<HTMLElement>,
    action: 'directory' | 'type',
    identity: string,
    run: () => unknown,
  ) => {
    const admitted = takeGuideFocusIntent(focusIntent, event, key);
    setFocusCompletion(undefined);
    if (!admitted) {
      focusIntent.current = undefined;
      run();
      return;
    }
    admitted.action = action;
    admitted.identity = identity;
    const token = {};
    admitted.token = token;
    const result = run();
    void Promise.resolve(result).then(
      () => {
        if (focusIntent.current === admitted) setFocusCompletion({ token, intent: admitted });
      },
      () => {
        if (focusIntent.current === admitted) setFocusCompletion({ token, intent: admitted });
      },
    );
  };
  const submitPrefix = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    retireFocusIntent();
    setSearch({ draft: search.draft, query: search.draft, cursor: undefined, active: true });
  };
  const submitExact = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    retireFocusIntent();
    setSelection({
      key,
      type: searchExactDraft,
      requested: searchExactDraft.length > 0,
      attempt: currentSelection.attempt + 1,
    });
  };
  const retryPage = (event: MouseEvent<HTMLButtonElement>) => {
    const restart = Boolean(pageRead && !pageRead.ok && pageRead.reason === 'stale' && search.cursor);
    const cursor = restart ? undefined : search.cursor;
    runFocusAction(event, 'directory', JSON.stringify([query, cursor ?? null]), () => {
      if (restart) {
        setSearch({ draft: search.draft, query, cursor: undefined, active: true });
        return;
      }
      return pageQuery.refetch();
    });
  };
  const typeResult = selectedRead;
  const typeFailure = typeResult && !typeResult.ok ? typeResult.reason : undefined;
  const invalidAddressProperty = Boolean(property && type && !field);

  useEffect(() => {
    const completion = focusCompletion;
    if (!completion || handledFocus.current === completion.token || focusIntent.current !== completion.intent) return;
    const intent = completion.intent;
    if (intent.scope !== key) {
      focusIntent.current = undefined;
      return;
    }
    const identity =
      intent.action === 'directory'
        ? JSON.stringify([query, search.cursor ?? null])
        : JSON.stringify([query, search.cursor ?? null, currentSelection.type, currentSelection.attempt]);
    if (intent.identity !== identity) {
      focusIntent.current = undefined;
      return;
    }
    if (intent.action === 'directory' && (pageQuery.isFetching || (!pageRead && !pageQuery.isError))) return;
    if (intent.action === 'type' && (typeQuery.isFetching || (!selectedRead && !typeQuery.isError))) return;
    handledFocus.current = completion.token;
    const target =
      intent.action === 'directory'
        ? section.current?.querySelector<HTMLElement>('[data-guide-recovery]') ??
          section.current?.querySelector<HTMLElement>('[data-guide-directory]') ??
          null
        : guideRecoveryTarget(section.current);
    finishGuideFocusIntent(focusIntent, intent, target);
  }, [
    currentSelection.attempt,
    currentSelection.type,
    focusCompletion,
    key,
    pageQuery.isError,
    pageQuery.isFetching,
    pageRead,
    query,
    search.cursor,
    selectedRead,
    typeQuery.isError,
    typeQuery.isFetching,
  ]);

  return (
    <section ref={section} className="space-y-6">
      <form className="space-y-3" onSubmit={submitPrefix}>
        <Field>
          <FieldLabel htmlFor={prefixId}>{m.guide_prefix_label({}, o)}</FieldLabel>
          <input
            className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8 md:pointer-fine:text-sm"
            id={prefixId}
            maxLength={512}
            value={search.draft}
            placeholder={m.guide_prefix_placeholder({}, o)}
            onChange={(event) => setSearch({ ...search, draft: event.target.value })}
          />
        </Field>
        <Button type="submit" variant="outline" className={actionClassName}>
          {m.guide_search({}, o)}
        </Button>
      </form>
      <form className="space-y-3" onSubmit={submitExact}>
        <Field>
          <FieldLabel htmlFor={exactId}>{m.guide_exact_id_label({}, o)}</FieldLabel>
          <input
            className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8 md:pointer-fine:text-sm"
            id={exactId}
            maxLength={guideIdentifierLimit}
            value={searchExactDraft}
            placeholder={m.guide_exact_id_placeholder({}, o)}
            onChange={(event) => setSearchExactDraft(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" className={actionClassName}>
          {m.guide_lookup({}, o)}
        </Button>
      </form>

      {search.active && pageQuery.isFetching && <p role="status">{m.guide_loading({}, o)}</p>}
      {search.active && pageRead && !pageRead.ok && (
        <section className="space-y-3">
          <p role="alert" tabIndex={-1} data-guide-recovery className={recoveryClassName}>
            {pageRead.reason === 'stale'
              ? m.guide_stale_results({}, o)
              : pageRead.reason === 'invalid'
                ? m.guide_invalid({}, o)
                : pageRead.reason === 'denied'
                  ? m.guide_denied({}, o)
                  : pageRead.reason === 'concealed'
                    ? m.guide_concealed({}, o)
                    : m.guide_unavailable({}, o)}
          </p>
          {pageRead.reason !== 'invalid' && pageRead.reason !== 'concealed' && (
            <Button
              variant="outline"
              className={actionClassName}
              onKeyDown={(event) => armGuideFocusIntent(focusIntent, event, key)}
              onBlur={(event) => cancelGuideFocusIntentOnBlur(focusIntent, event)}
              onClick={retryPage}
              disabled={pageQuery.isFetching}
              aria-busy={pageQuery.isFetching || undefined}
            >
              {pageRead.reason === 'stale' ? m.guide_search({}, o) : m.guide_retry({}, o)}
            </Button>
          )}
        </section>
      )}
      {page && (
        <section
          data-guide-directory
          tabIndex={-1}
          className={recoveryClassName}
          aria-label={m.guide_search_results({}, o)}
        >
          {page.types.length === 0 ? (
            <p role="status" tabIndex={-1} data-guide-recovery className={recoveryClassName}>
              {query ? m.guide_no_prefix_matches({}, o) : m.guide_empty({}, o)}
            </p>
          ) : (
            <ul className="space-y-2">
              {page.types.map((entry) => (
                <li key={entry.typeId}>
                  <button
                    type="button"
                    className={cn(linkClassName, 'text-left')}
                    onKeyDown={(event) => armGuideFocusIntent(focusIntent, event, key)}
                    onBlur={(event) => cancelGuideFocusIntentOnBlur(focusIntent, event)}
                    onClick={(event) =>
                      runFocusAction(
                        event,
                        'type',
                        JSON.stringify([
                          query,
                          search.cursor ?? null,
                          entry.typeId,
                          currentSelection.attempt + 1,
                        ]),
                        () => {
                          setSearchExactDraft(entry.typeId);
                          setSelection({
                            key,
                            type: entry.typeId,
                            requested: entry.typeId.length > 0,
                            attempt: currentSelection.attempt + 1,
                          });
                        },
                      )
                    }
                    aria-current={currentSelection.type === entry.typeId ? 'true' : undefined}
                  >
                    <span>{entry.label}</span>
                    <code className="break-all text-sm">{entry.typeId}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {page.next && (
            <Button
              type="button"
              variant="outline"
              className={actionClassName}
              disabled={pageQuery.isFetching}
              onKeyDown={(event) => armGuideFocusIntent(focusIntent, event, key)}
              onBlur={(event) => cancelGuideFocusIntentOnBlur(focusIntent, event)}
              onClick={(event) =>
                runFocusAction(event, 'directory', JSON.stringify([query, page.next ?? null]), () =>
                  setSearch({ draft: search.draft, query, cursor: page.next ?? undefined, active: true }),
                )
              }
            >
              {m.guide_next_page({}, o)}
            </Button>
          )}
        </section>
      )}
      {search.active && !pageRead && !pageQuery.isFetching && <p role="status">{m.guide_loading({}, o)}</p>}

      {currentSelection.requested && typeQuery.isFetching && <p role="status">{m.guide_loading({}, o)}</p>}
      {typeFailure && (
        <section className="space-y-3">
          <p
            role={typeFailure === 'no-match' ? 'status' : 'alert'}
            tabIndex={-1}
            data-guide-recovery
            className={recoveryClassName}
          >
            {typeFailure === 'no-match'
              ? m.guide_no_exact_match({}, o)
              : typeFailure === 'stale'
                ? m.guide_stale_results({}, o)
                : typeFailure === 'invalid'
                  ? m.guide_invalid({}, o)
                  : typeFailure === 'denied'
                    ? m.guide_denied({}, o)
                    : typeFailure === 'concealed'
                      ? m.guide_concealed({}, o)
                      : m.guide_unavailable({}, o)}
          </p>
          {(typeFailure === 'unavailable' || typeFailure === 'denied' || typeFailure === 'stale') && (
            <Button
              variant="outline"
              className={actionClassName}
              onKeyDown={(event) => armGuideFocusIntent(focusIntent, event, key)}
              onBlur={(event) => cancelGuideFocusIntentOnBlur(focusIntent, event)}
              onClick={(event) =>
                runFocusAction(
                  event,
                  'type',
                  JSON.stringify([
                    query,
                    search.cursor ?? null,
                    currentSelection.type,
                    currentSelection.attempt,
                  ]),
                  () => typeQuery.refetch(),
                )
              }
              disabled={typeQuery.isFetching}
              aria-busy={typeQuery.isFetching || undefined}
            >
              {m.guide_retry({}, o)}
            </Button>
          )}
        </section>
      )}
      {currentSelection.requested && !selectedRead && typeQuery.isFetching === false && currentSelection.type && (
        <p role="status">{m.guide_loading({}, o)}</p>
      )}

      {descriptor && release && type && !invalidAddressProperty && (
        <section className="space-y-5">
          <details className="text-sm text-muted-foreground">
            <summary className={summaryClassName}>{m.guide_active({}, o)}</summary>
            <p className="mt-2 break-all">
              {m.guide_digest({}, o)}: <code>{descriptor.releaseDigest}</code>
            </p>
          </details>
          <header className="space-y-2">
            <ContentItemHeading
              level={2}
              id={`${exactId}-meaning`}
              tabIndex={-1}
              data-guide-recovery
              className={cn('text-xl font-semibold', recoveryClassName)}
            >
              <Meaning values={type.labels} locale={locale} />
            </ContentItemHeading>
            <p>
              <Meaning values={type.descriptions} locale={locale} />
            </p>
          </header>
          {field && property ? (
            <section>
              <ContentItemFrame as="div" className="flex min-w-0 flex-col gap-5 p-4 sm:p-6">
                <header className="space-y-2">
                  <ContentItemHeading
                    level={3}
                    tabIndex={-1}
                    data-guide-recovery
                    className={cn('text-lg font-semibold', recoveryClassName)}
                  >
                    <Meaning values={field.labels} locale={locale} />
                  </ContentItemHeading>
                  <p>
                    <Meaning values={field.descriptions} locale={locale} />
                  </p>
                </header>
                <Constraints definition={field} release={release} locale={locale} />
                <p className="text-sm">
                  {field.disclosure === 'sourceOrConsent' ? m.guide_consent({}, o) : m.guide_references({}, o)}
                </p>
                <details className="text-sm text-muted-foreground">
                  <summary className={summaryClassName}>{m.guide_identifier({}, o)}</summary>
                  <code className="break-all">{property}</code>
                </details>
                <a
                  className={linkClassName}
                  href={definitionGuideHref(locale, { ...address, type: currentSelection.type, property: undefined })}
                >
                  {m.guide_fields({}, o)}
                </a>
              </ContentItemFrame>
            </section>
          ) : (
            <>
              <ContentItemHeading level={3} className="font-semibold">
                {m.guide_fields({}, o)}
              </ContentItemHeading>
              {type.properties.length === 0 ? (
                <p>{m.guide_no_fields({}, o)}</p>
              ) : (
                <ul className="space-y-3">
                  {type.properties.map((id) => (
                    <li key={id} className="min-w-0">
                      <ContentItemFrame as="div" className="min-w-0 px-3 py-2">
                        {release.properties[id] ? (
                          <ContentItemTitleLink
                            className={cn(linkClassName, 'w-full')}
                            href={definitionGuideHref(locale, {
                              ...address,
                              type: currentSelection.type,
                              property: id,
                            })}
                          >
                            <Meaning values={release.properties[id]?.labels} locale={locale} />
                          </ContentItemTitleLink>
                        ) : (
                          <p>{m.guide_missing({}, o)}</p>
                        )}
                      </ContentItemFrame>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="text-sm text-muted-foreground">{m.guide_native({}, o)}</p>
        </section>
      )}
    </section>
  );
}

export function DefinitionGuideContent({
  address,
  locale,
  transport,
  read,
  retry,
  retryPending = false,
  retryCompletion,
}: {
  address: GuideAddress;
  locale: string;
  transport?: GuideTransport;
  read?: GuideRead | undefined;
  retry: (intent?: GuideFocusIntent) => boolean | void;
  retryPending?: boolean;
  retryCompletion?: { token: object; intent?: GuideFocusIntent } | undefined;
}) {
  const o = { locale: locale as never };
  const typeId = useId();
  const article = useRef<HTMLElement>(null);
  const focusIntent = useGuideFocusIntent();
  const handledRetry = useRef<object | undefined>(undefined);
  const actionScope = JSON.stringify([address.type, address.property, address.release, address.returnTo, locale]);
  if (focusIntent.current && focusIntent.current.scope !== actionScope) focusIntent.current = undefined;
  useEffect(() => {
    const completion = retryCompletion;
    if (!completion || retryPending || handledRetry.current === completion.token) return;
    handledRetry.current = completion.token;
    const intent = completion.intent;
    if (!intent || focusIntent.current !== intent) return;
    finishGuideFocusIntent(focusIntent, intent, guideRecoveryTarget(article.current));
  }, [retryCompletion, retryPending]);
  // A local choice belongs to this exact definition address. Object identity is
  // unsuitable here: route search objects can be recreated without navigation.
  const addressKey = JSON.stringify([address.type, address.property, address.release]);
  const [selection, setSelection] = useState({
    addressKey,
    type: address.type ?? '',
  });
  const selected = selection.addressKey === addressKey ? selection.type : (address.type ?? '');
  if (selection.addressKey !== addressKey) {
    // Reset during render so neither a stale frame nor a later Back navigation
    // can restore a local choice made for a previous address.
    setSelection({ addressKey, type: selected });
  }
  const back = guideReturnTo(address.returnTo, locale) ?? `/${locale}/catalogue/new`;
  const release = read?.ok && read.pin === 'pinned' && !retryPending ? read.release : undefined;
  const types = release ? guideTypes(release, locale) : [];
  const type = selected && release?.types[selected];
  const property = selected === address.type ? address.property : undefined;
  const field = property && release?.properties[property];
  return (
    <article
      ref={article}
      className="mx-auto w-full min-w-0 max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]"
    >
      <header className="space-y-3">
        <PageHeading tabIndex={-1} className={recoveryClassName}>
          {m.guide_title({}, o)}
        </PageHeading>
        <p className="text-muted-foreground">{m.guide_intro({}, o)}</p>
        <a className={buttonVariants({ variant: 'outline', className: actionClassName })} href={back}>
          {m.guide_back({}, o)}
        </a>
      </header>
      {(!read || retryPending) && <p role="status">{m.guide_loading({}, o)}</p>}
      {read && !read.ok && (
        <section className="space-y-4">
          {!retryPending && (
            <p role="alert" tabIndex={-1} data-guide-recovery className={recoveryClassName}>
              {read.reason === 'invalid'
                ? m.guide_invalid({}, o)
                : read.reason === 'no-match'
                  ? m.guide_no_exact_match({}, o)
                  : read.reason === 'stale'
                    ? m.guide_stale_results({}, o)
                    : read.reason === 'denied'
                      ? m.guide_denied({}, o)
                      : read.reason === 'concealed'
                        ? m.guide_concealed({}, o)
                        : m.guide_unavailable({}, o)}
            </p>
          )}
          {(read.reason === 'unavailable' || read.reason === 'denied') && (
            <Button
              variant="outline"
              className={actionClassName}
              onKeyDown={(event) => armGuideFocusIntent(focusIntent, event, actionScope)}
              onBlur={(event) => cancelGuideFocusIntentOnBlur(focusIntent, event)}
              onClick={(event) => {
                const intent = takeGuideFocusIntent(focusIntent, event, actionScope);
                if (retry(intent) === false) focusIntent.current = undefined;
              }}
              disabled={retryPending}
              aria-busy={retryPending || undefined}
            >
              {m.guide_retry({}, o)}
            </Button>
          )}
        </section>
      )}
      {transport && address.release === undefined && (
        <ActiveGuide
          address={address}
          locale={locale}
          initial={retryPending ? undefined : read}
          transport={transport}
        />
      )}
      {read?.ok && release && (
        <>
          <details className="text-sm text-muted-foreground">
            <summary className={summaryClassName}>{m.guide_pinned({}, o)}</summary>
            <p className="mt-2 break-all">
              {m.guide_digest({}, o)}: <code>{release.digest}</code>
            </p>
          </details>
          <a
            className={cn(linkClassName, 'text-sm')}
            href={definitionGuideHref(locale, { ...address, release: undefined })}
          >
            {m.guide_active({}, o)}
          </a>
          {types.length === 0 ? (
            <p role="status" tabIndex={-1} data-guide-recovery className={recoveryClassName}>
              {m.guide_empty({}, o)}
            </p>
          ) : (
            <Field>
              <FieldLabel className="min-w-0 max-w-full flex-wrap" htmlFor={typeId}>
                {m.catalogue_create_type({}, o)}
              </FieldLabel>
              <NativeSelect
                className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11 md:pointer-fine:[&_select]:min-h-8"
                id={typeId}
                aria-describedby={type ? `${typeId}-meaning` : undefined}
                value={selected}
                onChange={(event) =>
                  setSelection({
                    addressKey,
                    type: event.target.value,
                  })
                }
              >
                <NativeSelectOption value="">{m.catalogue_create_choose_type({}, o)}</NativeSelectOption>
                {types.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          {type && (
            <section className="space-y-5">
              <header className="space-y-2">
                <ContentItemHeading
                  level={2}
                  id={`${typeId}-meaning`}
                  tabIndex={-1}
                  data-guide-recovery
                  className={cn('text-xl font-semibold', recoveryClassName)}
                >
                  <Meaning values={type.labels} locale={locale} />
                </ContentItemHeading>
                <p>
                  <Meaning values={type.descriptions} locale={locale} />
                </p>
              </header>
              {field && property ? (
                <section>
                  <ContentItemFrame as="div" className="flex min-w-0 flex-col gap-5 p-4 sm:p-6">
                    <header className="space-y-2">
                      <ContentItemHeading
                        level={3}
                        tabIndex={-1}
                        data-guide-recovery
                        className={cn('text-lg font-semibold', recoveryClassName)}
                      >
                        <Meaning values={field.labels} locale={locale} />
                      </ContentItemHeading>
                      <p>
                        <Meaning values={field.descriptions} locale={locale} />
                      </p>
                    </header>
                    <Constraints definition={field} release={release} locale={locale} />
                    <p className="text-sm">
                      {field.disclosure === 'sourceOrConsent' ? m.guide_consent({}, o) : m.guide_references({}, o)}
                    </p>
                    <details className="text-sm text-muted-foreground">
                      <summary className={summaryClassName}>{m.guide_identifier({}, o)}</summary>
                      <code className="break-all">{property}</code>
                    </details>
                    <a
                      className={linkClassName}
                      href={definitionGuideHref(locale, { ...address, type: selected, property: undefined })}
                    >
                      {m.guide_fields({}, o)}
                    </a>
                  </ContentItemFrame>
                </section>
              ) : (
                <>
                  <ContentItemHeading level={3} className="font-semibold">
                    {m.guide_fields({}, o)}
                  </ContentItemHeading>
                  {type.properties.length === 0 ? (
                    <p>{m.guide_no_fields({}, o)}</p>
                  ) : (
                    <ul className="space-y-3">
                      {type.properties.map((id) => (
                        <li key={id} className="min-w-0">
                          <ContentItemFrame as="div" className="min-w-0 px-3 py-2">
                            {release.properties[id] ? (
                              <ContentItemTitleLink
                                className={cn(linkClassName, 'w-full')}
                                href={definitionGuideHref(locale, { ...address, type: selected, property: id })}
                              >
                                <Meaning values={release.properties[id]?.labels} locale={locale} />
                              </ContentItemTitleLink>
                            ) : (
                              <p>{m.guide_missing({}, o)}</p>
                            )}
                          </ContentItemFrame>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <p className="text-sm text-muted-foreground">{m.guide_native({}, o)}</p>
            </section>
          )}
        </>
      )}
    </article>
  );
}

/** Opening guidance keeps the editor's draft and exact uncertain request in its original tab. */
export function DefinitionGuideLink({
  locale,
  address,
  field = false,
}: {
  locale: string;
  address: GuideAddress;
  field?: boolean;
}) {
  const o = { locale: locale as never };
  return (
    <a
      className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal text-sm text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
      href={definitionGuideHref(locale, address)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {field ? m.guide_field_help({}, o) : m.guide_type_help({}, o)}
      <span className="sr-only"> · {m.guide_new_tab({}, o)}</span>
    </a>
  );
}
