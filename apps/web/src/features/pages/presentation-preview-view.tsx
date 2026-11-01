import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { createContext, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { AnonymousSessionContext } from '../../session/query';
import { FeatureSlotsProvider } from '../../shell/feature-slots';
import { accountHref } from '../../subject/subject-href';
import { dataComponents, PageData } from './data';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import type { PresentationPreview, PresentationPreviewInput } from './presentation-preview';
import { CompositionRender } from './render';
import { subjectPageMessages } from './route-support';

export type PresentationPreviewProps = {
  locale: string;
  /** Injection is for connected workflow stories; production always uses the prepared BFF. */
  read: (input: PresentationPreviewInput) => Promise<PresentationPreview>;
  initial?: PresentationPreview;
};

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
              messages={subjectPageMessages()}
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
        <a className="break-all text-primary underline underline-offset-4" href={accountHref(locale, result.handle)}>
          @{result.handle}
        </a>
      )}
    </div>
  );
}

export function PresentationPreviewPanel({ locale, read, initial }: PresentationPreviewProps) {
  const [kind, setKind] = useState<'subject' | 'route'>(initial?.ok && 'route' in initial.target ? 'route' : 'subject');
  const [address, setAddress] = useState(
    initial?.ok ? ('subject' in initial.target ? initial.target.subject : initial.target.route) : '',
  );
  const [realm, setRealm] = useState(initial?.ok && 'subject' in initial.target ? (initial.target.realm ?? '') : '');
  const [result, setResult] = useState<PresentationPreview | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const o = { locale: locale as never };

  function clear() {
    request.current += 1;
    setBusy(false);
    setResult(null);
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    const serial = ++request.current;
    setBusy(true);
    setResult(null);
    const input: PresentationPreviewInput = {
      target:
        kind === 'route'
          ? { route: address.trim() }
          : {
              subject: address.trim(),
              ...(realm.trim() ? { realm: realm.trim() } : {}),
            },
      locale,
    };
    try {
      const next = await read(input);
      if (serial === request.current) setResult(next);
    } catch {
      if (serial === request.current) setResult({ ok: false, reason: 'unavailable' });
    } finally {
      if (serial === request.current) setBusy(false);
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
      aria-labelledby="presentation-preview-title"
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <header className="space-y-2">
        <h2 id="presentation-preview-title" className="text-xl font-semibold">
          {m.presentation_preview_title({}, o)}
        </h2>
        <p className="text-sm text-muted-foreground">{m.presentation_preview_help({}, o)}</p>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {m.presentation_editor_resolver_details({}, o)}
          </summary>
          <p className="mt-2 text-muted-foreground">{m.presentation_preview_precedence({}, o)}</p>
        </details>
      </header>
      <form onSubmit={inspect} className="space-y-3" aria-busy={busy}>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full sm:w-44">
            <FieldLabel htmlFor="presentation-preview-kind">{m.presentation_preview_target({}, o)}</FieldLabel>
            <NativeSelect
              id="presentation-preview-kind"
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
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="presentation-preview-address">{m.presentation_preview_address({}, o)}</FieldLabel>
            <Input
              id="presentation-preview-address"
              value={address}
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={kind === 'subject' ? 36 : 256}
              aria-describedby="presentation-preview-address-help"
              onChange={(event) => {
                clear();
                setAddress(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? m.presentation_preview_loading({}, o) : m.presentation_preview_inspect({}, o)}
          </Button>
          {busy && (
            <Button type="button" variant="outline" onClick={clear}>
              {m.presentation_preview_close({}, o)}
            </Button>
          )}
        </div>
        <p id="presentation-preview-address-help" className="text-sm text-muted-foreground">
          {m.presentation_preview_address_help({}, o)}
        </p>
        {kind === 'subject' && (
          <Field>
            <FieldLabel htmlFor="presentation-preview-realm">{m.presentation_preview_realm({}, o)}</FieldLabel>
            <Input
              id="presentation-preview-realm"
              value={realm}
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
              aria-describedby="presentation-preview-realm-help"
              onChange={(event) => {
                clear();
                setRealm(event.target.value);
              }}
            />
            <p id="presentation-preview-realm-help" className="text-sm text-muted-foreground">
              {m.presentation_preview_realm_help({}, o)}
            </p>
          </Field>
        )}
      </form>
      {result && !result.ok && <PreviewFailure result={result} locale={locale} />}
      {result?.ok && (
        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">{m.presentation_editor_preview_current({}, o)}</h3>
            <Button type="button" variant="outline" onClick={clear}>
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
            <summary className="cursor-pointer font-medium">{m.presentation_editor_preview_details({}, o)}</summary>
            <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{m.presentation_preview_head({}, o)}</dt>
              <dd>{result.head}</dd>
              <dt className="text-muted-foreground">{m.presentation_preview_profile({}, o)}</dt>
              <dd className="break-all font-mono">{result.page.profile}</dd>
              <dt className="text-muted-foreground">{m.presentation_preview_template({}, o)}</dt>
              <dd className="break-all">
                {scopes[result.page.template.scope]({}, o)}
                {result.page.template.key ? `: ${result.page.template.key}` : ''}
              </dd>
              {result.page.subject && (
                <>
                  <dt className="text-muted-foreground">{m.presentation_preview_terminal({}, o)}</dt>
                  <dd className="break-all font-mono">{result.page.subject}</dd>
                </>
              )}
              {result.page.context && (
                <>
                  <dt className="text-muted-foreground">{m.presentation_preview_context({}, o)}</dt>
                  <dd className="break-all">
                    {result.page.context.population.kind === 'realm'
                      ? `${result.page.context.population.title} · `
                      : ''}
                    {result.page.context.id}
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-3 text-sm text-muted-foreground">{m.presentation_preview_head_help({}, o)}</p>
          </details>
          <details className="min-w-0 rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">{m.presentation_preview_document({}, o)}</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(result.page.document, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
