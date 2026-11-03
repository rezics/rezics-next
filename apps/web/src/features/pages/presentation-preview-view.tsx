import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { createContext, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { AnonymousSessionContext } from '../../session/query';
import { FeatureSlotsProvider } from '../../shell/feature-slots';
import { accountHref } from '../../subject/subject-href';
import { dataComponents, PageData } from './data';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { usePreviewCloseFocus } from './presentation-preview-focus';
import type { PresentationPreview, PresentationPreviewInput } from './presentation-preview';
import { CompositionRender } from './render';
import { subjectPageMessages } from './route-support';

export type PresentationPreviewProps = {
  locale: string;
  /** Injection is for connected workflow stories; production always uses the prepared BFF. */
  read: (input: PresentationPreviewInput) => Promise<PresentationPreview>;
  initial?: PresentationPreview;
};

type PreviewRequestContext = Pick<PresentationPreviewProps, 'locale' | 'read'>;
type PreviewInspection =
  | { status: 'idle' }
  | { status: 'loading'; context: PreviewRequestContext }
  | { status: 'complete'; context: PreviewRequestContext; result: PresentationPreview };

function samePreviewRequestContext(left: PreviewRequestContext, right: PreviewRequestContext) {
  return left.locale === right.locale && left.read === right.read;
}

/** Connected examples can supply a read adapter without replacing any part of the curation region. */
export const PresentationPreviewContext = createContext<Partial<Omit<PresentationPreviewProps, 'locale'>>>({});

/** The same document, data adapters, title and cover as the public renderer, without admin host slots or SEO. */
export function PublishedPresentationPage({ result }: { result: Extract<PresentationPreview, { ok: true }> }) {
  const [client] = useState(() => {
    const isolated = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } },
    });
    // Nested registry controls see anonymous state, never the curator's session or its query data.
    isolated.setQueryData(['session'], { state: 'signed-out', csrfToken: null, subject: null });
    return isolated;
  });
  const { page, locale } = result;
  return (
    <QueryClientProvider client={client}>
      <AnonymousSessionContext.Provider value={true}>
        <FeatureSlotsProvider>
          <PageHost>
            <PageData
              locale={locale}
              subject={page.subject}
              context={page.context}
              document={page.document}
              reads={page.reads}
              messages={subjectPageMessages(locale)}
            >
              <CompositionRender
                document={page.document}
                definitions={pageDefinitions}
                components={{ ...layoutComponents, ...dataComponents }}
                root={PageRoot}
              />
            </PageData>
          </PageHost>
        </FeatureSlotsProvider>
      </AnonymousSessionContext.Provider>
    </QueryClientProvider>
  );
}

function PreviewFailure({ result, locale }: { result: Exclude<PresentationPreview, { ok: true }>; locale: string }) {
  const text = {
    invalid: m.presentation_preview_invalid,
    denied: m.presentation_preview_denied,
    missing: m.presentation_preview_missing,
    unavailable: m.presentation_preview_unavailable,
    changed: m.presentation_preview_changed,
    redirect: m.presentation_preview_redirect,
  }[result.reason];
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
      <p>{text({}, { locale: locale as never })}</p>
      {result.reason === 'redirect' && (
        <a
          className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={accountHref(locale, result.handle)}
        >
          <span className="min-w-0 break-all wrap-anywhere">@{result.handle}</span>
        </a>
      )}
    </div>
  );
}

export function PresentationPreviewPanel({ locale, read, initial }: PresentationPreviewProps) {
  const instance = useId();
  const titleId = `${instance}-title`;
  const helpId = `${instance}-help`;
  const kindId = `${instance}-kind`;
  const addressId = `${instance}-address`;
  const addressHelpId = `${instance}-address-help`;
  const realmId = `${instance}-realm`;
  const realmHelpId = `${instance}-realm-help`;
  const headId = `${instance}-head`;
  const headHelpId = `${instance}-head-help`;
  const profileId = `${instance}-profile`;
  const templateId = `${instance}-template`;
  const subjectId = `${instance}-subject`;
  const contextId = `${instance}-context`;
  const documentId = `${instance}-document`;
  const summaryClassName =
    'list-item list-inside min-h-11 min-w-11 max-w-full cursor-pointer rounded-sm py-3 whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
  const referenceClassName =
    'min-w-0 rounded-sm break-all select-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
  const previewControlClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';
  const previewSelectClass = 'w-full min-w-0 max-w-full [&_select]:min-h-11';
  const previewInputClass = 'min-h-11';
  const [kind, setKind] = useState<'subject' | 'route'>(initial?.ok && 'route' in initial.target ? 'route' : 'subject');
  const [address, setAddress] = useState(
    initial?.ok ? ('subject' in initial.target ? initial.target.subject : initial.target.route) : '',
  );
  const [realm, setRealm] = useState(initial?.ok && 'subject' in initial.target ? (initial.target.realm ?? '') : '');
  const [inspection, setInspection] = useState<PreviewInspection>(() =>
    initial ? { status: 'complete', context: { locale, read }, result: initial } : { status: 'idle' },
  );
  const request = useRef(0);
  const mounted = useRef(false);
  const requestContext = useRef<PreviewRequestContext>({ locale, read });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    const nextContext = { locale, read };
    if (samePreviewRequestContext(requestContext.current, nextContext)) return;
    requestContext.current = nextContext;
    request.current += 1;
    setInspection({ status: 'idle' });
  }, [locale, read]);
  const currentInspection =
    'context' in inspection && samePreviewRequestContext(inspection.context, { locale, read })
      ? inspection
      : { status: 'idle' as const };
  const busy = currentInspection.status === 'loading';
  const result = currentInspection.status === 'complete' ? currentInspection.result : null;
  const closeFocus = usePreviewCloseFocus({ locale, read }, !busy);
  const o = { locale: locale as never };

  function clear() {
    if (!mounted.current) return;
    request.current += 1;
    setInspection({ status: 'idle' });
  }

  function closePreview(source: HTMLButtonElement) {
    closeFocus.captureCloseFocus(source);
    clear();
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!mounted.current) return;
    const context = { locale, read };
    const serial = ++request.current;
    setInspection({ status: 'loading', context });
    const input: PresentationPreviewInput = {
      target:
        kind === 'route'
          ? { route: address.trim() }
          : {
              subject: address.trim(),
              ...(realm.trim() ? { realm: realm.trim() } : {}),
            },
      locale: context.locale,
    };
    const isCurrent = () =>
      mounted.current && serial === request.current && samePreviewRequestContext(requestContext.current, context);
    try {
      const next = await context.read(input);
      if (isCurrent()) setInspection({ status: 'complete', context, result: next });
    } catch {
      if (isCurrent()) {
        setInspection({ status: 'complete', context, result: { ok: false, reason: 'unavailable' } });
      }
    }
  }

  const scopes = {
    route: m.presentation_preview_scope_route,
    type: m.presentation_preview_scope_type,
    base: m.presentation_preview_scope_base,
    generic: m.presentation_preview_scope_generic,
  };
  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={helpId}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <header className="space-y-2">
        <h2 id={titleId} className="text-xl font-semibold wrap-anywhere">
          {m.presentation_preview_title({}, o)}
        </h2>
        <p id={helpId} className="text-sm text-muted-foreground wrap-anywhere">
          {m.presentation_preview_help({}, o)}
        </p>
        <details className="min-w-0 text-sm">
          <summary className={`${summaryClassName} text-muted-foreground`}>
            {m.presentation_editor_resolver_details({}, o)}
          </summary>
          <p className="mt-2 text-muted-foreground wrap-anywhere">{m.presentation_preview_precedence({}, o)}</p>
        </details>
      </header>
      <form onSubmit={inspect} className="space-y-3" aria-busy={busy}>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full sm:w-44">
            <FieldLabel htmlFor={kindId}>{m.presentation_preview_target({}, o)}</FieldLabel>
            <NativeSelect
              id={kindId}
              className={previewSelectClass}
              value={kind}
              onChange={(event) => {
                clear();
                setKind(event.target.value as 'subject' | 'route');
                setAddress('');
                setRealm('');
              }}
            >
              <NativeSelectOption value="subject">{m.presentation_preview_subject({}, o)}</NativeSelectOption>
              <NativeSelectOption value="route">{m.presentation_preview_route({}, o)}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="min-w-0 flex-1 basis-full sm:basis-0">
            <FieldLabel htmlFor={addressId}>{m.presentation_preview_address({}, o)}</FieldLabel>
            <Input
              id={addressId}
              className={previewInputClass}
              value={address}
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={kind === 'subject' ? 36 : 256}
              aria-describedby={addressHelpId}
              onChange={(event) => {
                clear();
                setAddress(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" className={previewControlClass} disabled={busy} ref={closeFocus.inspectRef}>
            {busy ? m.presentation_preview_loading({}, o) : m.presentation_preview_inspect({}, o)}
          </Button>
          {busy && (
            <Button
              type="button"
              variant="outline"
              className={previewControlClass}
              onClick={(event) => closePreview(event.currentTarget)}
            >
              {m.presentation_preview_close({}, o)}
            </Button>
          )}
        </div>
        <p id={addressHelpId} className="text-sm text-muted-foreground wrap-anywhere">
          {m.presentation_preview_address_help({}, o)}
        </p>
        {kind === 'subject' && (
          <Field>
            <FieldLabel htmlFor={realmId}>{m.presentation_preview_realm({}, o)}</FieldLabel>
            <Input
              id={realmId}
              className={previewInputClass}
              value={realm}
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
              aria-describedby={realmHelpId}
              onChange={(event) => {
                clear();
                setRealm(event.target.value);
              }}
            />
            <p id={realmHelpId} className="text-sm text-muted-foreground wrap-anywhere">
              {m.presentation_preview_realm_help({}, o)}
            </p>
          </Field>
        )}
      </form>
      {result && !result.ok && <PreviewFailure result={result} locale={locale} />}
      {result?.ok && (
        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold wrap-anywhere">{m.presentation_editor_preview_current({}, o)}</h3>
            <Button
              type="button"
              variant="outline"
              className={previewControlClass}
              onClick={(event) => closePreview(event.currentTarget)}
            >
              {m.presentation_preview_close({}, o)}
            </Button>
          </div>
          <div data-slot="published-presentation-preview" className="min-w-0 border-t border-border pt-6">
            <PublishedPresentationPage
              key={`${result.page.profile}:${result.page.subject}:${request.current}`}
              result={result}
            />
          </div>
          <details className="min-w-0 rounded-lg border border-border p-3">
            <summary className={`${summaryClassName} font-medium`}>
              {m.presentation_editor_preview_details({}, o)}
            </summary>
            <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt id={headId} className="text-muted-foreground wrap-anywhere">
                {m.presentation_preview_head({}, o)}
              </dt>
              <dd tabIndex={0} aria-labelledby={headId} aria-describedby={headHelpId} className={referenceClassName}>
                {result.head}
              </dd>
              <dt id={profileId} className="text-muted-foreground wrap-anywhere">
                {m.presentation_preview_profile({}, o)}
              </dt>
              <dd tabIndex={0} aria-labelledby={profileId} className={`${referenceClassName} font-mono`}>
                {result.page.profile}
              </dd>
              <dt id={templateId} className="text-muted-foreground wrap-anywhere">
                {m.presentation_preview_template({}, o)}
              </dt>
              <dd tabIndex={0} aria-labelledby={templateId} className={referenceClassName}>
                {scopes[result.page.template.scope]({}, o)}
                {result.page.template.key ? `: ${result.page.template.key}` : ''}
              </dd>
              {result.page.subject && (
                <>
                  <dt id={subjectId} className="text-muted-foreground wrap-anywhere">
                    {m.presentation_preview_terminal({}, o)}
                  </dt>
                  <dd tabIndex={0} aria-labelledby={subjectId} className={`${referenceClassName} font-mono`}>
                    {result.page.subject}
                  </dd>
                </>
              )}
              {result.page.context && (
                <>
                  <dt id={contextId} className="text-muted-foreground wrap-anywhere">
                    {m.presentation_preview_context({}, o)}
                  </dt>
                  <dd tabIndex={0} aria-labelledby={contextId} className={referenceClassName}>
                    {result.page.context.population.kind === 'realm'
                      ? `${result.page.context.population.title} · `
                      : ''}
                    {result.page.context.id}
                  </dd>
                </>
              )}
            </dl>
            <p id={headHelpId} className="mt-3 text-sm text-muted-foreground wrap-anywhere">
              {m.presentation_preview_head_help({}, o)}
            </p>
          </details>
          <details className="min-w-0 rounded-lg border border-border p-3">
            <summary id={documentId} className={`${summaryClassName} font-medium`}>
              {m.presentation_preview_document({}, o)}
            </summary>
            <pre
              tabIndex={0}
              aria-labelledby={documentId}
              className={`mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs ${referenceClassName}`}
            >
              {JSON.stringify(result.page.document, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
