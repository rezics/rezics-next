import { platformRegistry, validateProfile, type CompositionDocument } from '@rezics/composition';
import { ClientOnly, useLocation } from '@tanstack/react-router';
import { lazy, Suspense, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import { getLocale } from '../../paraglide/runtime';
import { ErrorPage } from '../../shell/shell';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { csrfHeaders } from '../../threads/composer';
import { overviewOf, profileTemplates, withTemplate, type CurationFailure, type Template } from './curate';
import { publishCuration, readCuration, type CurationRead } from './curate-actions';
import { confirmSubjectCandidate, readSubjectCandidates } from './curate-actions';
import { CandidateReview } from '../../subject/candidate-review';
import { useSession } from '../../session/query';
import { PresentationPreviewPanel, PresentationPreviewContext } from './presentation-preview-view';
import { readPresentationPreview } from './curate-actions';
import { useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { CurationPublication, type PublicationConfirmation, type PublicationTransport } from './curation-publish';
import { CurationFailureNotice, CurationPublicationRecovery } from './curation-publish-view';

const publicationTransport: PublicationTransport = {
  publish: (data) => publishCuration({ data, headers: csrfHeaders() }),
  read: () => readCuration({ headers: csrfHeaders() }),
};

/** The subject's private curation region shares the existing prepared BFF transport. */
export function SubjectCandidateCuration({ id, locale }: { id: string; locale: string }) {
  const { state } = useSession();
  const field = new URLSearchParams(useLocation().searchStr).get('candidateField') ?? undefined;
  const initialProperty = field && field.length <= 256 ? field : undefined;
  if (state !== 'signed-in') return null;
  return (
    <CandidateReview
      key={`${id}:${locale}:${initialProperty ?? ''}`}
      initialProperty={initialProperty}
      id={id}
      locale={locale}
      transport={{
        read: (property, cursor, session) =>
          readSubjectCandidates({ data: { id, property, cursor, session }, headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectCandidate({ data, headers: csrfHeaders() }),
      }}
    />
  );
}

const PageEditor = lazy(() => import('./editor').then((module) => ({ default: module.PageEditor })));
const control =
  'min-h-11 rounded-lg border border-border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring';
const button = `${control} hover:bg-muted disabled:opacity-50`;
const editorTheme = {
  '--puck-color-surface': 'var(--card)',
  '--puck-color-surface-muted': 'var(--muted)',
  '--puck-color-surface-subtle': 'var(--background)',
  '--puck-color-border': 'var(--border)',
  '--puck-color-border-muted': 'var(--border)',
  '--puck-color-text': 'var(--foreground)',
  '--puck-color-text-secondary': 'var(--muted-foreground)',
  '--puck-color-text-muted': 'var(--muted-foreground)',
  '--puck-color-interactive': 'var(--primary)',
  '--puck-color-interactive-neutral-hover': 'var(--muted)',
  '--puck-color-interactive-soft': 'var(--muted)',
  '--puck-button-primary-color-text': 'var(--primary-foreground)',
  '--puck-button-primary-color-bg-hover': 'var(--primary)',
  '--puck-button-primary-color-bg-active': 'var(--primary)',
  '--puck-font-family': 'var(--font-interface)',
} as CSSProperties;

function Failure({ failure }: { failure: CurationFailure | Exclude<CurationRead, { ok: true }> }) {
  return <CurationFailureNotice failure={failure} />;
}

export function CurationView({
  initial,
  transport = publicationTransport,
}: {
  initial: CurationRead;
  transport?: PublicationTransport;
}) {
  const preview = useContext(PresentationPreviewContext);
  const [current, setCurrent] = useState(initial);
  const [failure, setFailure] = useState<CurationFailure | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setBusy] = useState(false);
  const [publication] = useState(() => new CurationPublication(transport));
  const publicationState = useSyncExternalStore(
    publication.subscribe,
    publication.getSnapshot,
    publication.getSnapshot,
  );
  const busy = loading || publicationState.busy;
  const [selected, setSelected] = useState<Template | null>(null);
  const [scope, setScope] = useState<'type' | 'route'>('type');
  const [key, setKey] = useState('');

  if ((!current.ok && current.reason === 'forbidden') || failure?.reason === 'forbidden') return <ErrorPage />;

  async function reload() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await transport.read();
      if (result.ok) {
        setCurrent(result);
        setSelected(null);
      } else setFailure(result.reason === 'signed-out' ? { ok: false, reason: 'forbidden' } : result);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }

  if (!current.ok)
    return (
      <div className="space-y-4">
        <Failure failure={current} />
        <button type="button" className={button} disabled={busy} onClick={reload}>
          {m.curation_reload()}
        </button>
      </div>
    );

  const { profile, head } = current;
  const templates = profileTemplates(profile);
  const document = !selected ? null : (overviewOf(profile, selected) ?? null);

  function addTemplate(event: FormEvent) {
    event.preventDefault();
    if (!current.ok || busy) return;
    const template = { scope, key };
    if (templates.some((item) => item.scope === scope && item.key === key)) {
      setFailure({
        ok: false,
        reason: 'invalid',
        errors: [{ pointer: `/${scope === 'type' ? 'types' : 'routes'}`, code: 'duplicate' }],
      });
      return;
    }
    const next = withTemplate(
      profile,
      template,
      structuredClone(overviewOf(profile, { scope: 'generic', key: null })!),
    );
    const errors = validateProfile(platformRegistry, next);
    if (errors.length > 0) {
      setFailure({ ok: false, reason: 'invalid', errors });
      return;
    }
    setCurrent({ ...current, profile: next });
    setSelected(template);
    setKey('');
    setFailure(null);
    setMessage(m.curation_added());
  }

  function published({ result }: PublicationConfirmation) {
    // Keep any edits made after the intent snapshot; the native result advances only its basis.
    setCurrent((draft) => (draft.ok ? { ...draft, digest: result.digest, head: result.head } : draft));
  }

  async function publish(edited?: CompositionDocument) {
    if (!current.ok || busy) return;
    const next = edited && selected ? withTemplate(profile, selected, edited) : profile;
    setCurrent({ ...current, profile: next });
    setFailure(null);
    setMessage('');
    const confirmation = await publication.start(next, head);
    if (confirmation) published(confirmation);
  }

  return (
    <article className="min-w-0 space-y-6 font-sans text-foreground" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{m.curation_heading()}</h1>
        <p className="text-muted-foreground">{m.curation_basis({ head })}</p>
        <p className="text-sm text-muted-foreground">{m.curation_editor_help()}</p>
      </header>
      {message ? (
        <p role="status" className="rounded-lg border border-border bg-card p-4">
          {message}
        </p>
      ) : null}
      {failure ? <Failure failure={failure} /> : null}
      <PresentationPreviewPanel
        key={getLocale()}
        locale={getLocale()}
        read={(input) => readPresentationPreview({ data: input, headers: csrfHeaders() })}
        {...preview}
      />
      <CurationPublicationRecovery
        publication={publication}
        profile={profile}
        head={head}
        onPublished={published}
        onReviewed={(active, choice) => {
          setCurrent(active);
          if (choice === 'discard') setSelected(null);
          setMessage(choice === 'keep' ? m.curation_reconciled() : m.curation_discarded());
        }}
      />
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <section aria-label={m.curation_templates()} className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-semibold">{m.curation_templates()}</h2>
          <ul className="flex flex-wrap gap-2">
            {templates.map((template) => (
              <li key={`${template.scope}:${template.key}`} className="min-w-0 max-w-full">
                <button
                  type="button"
                  className={`${button} max-w-full break-all py-2 text-start`}
                  aria-pressed={selected?.scope === template.scope && selected.key === template.key}
                  disabled={selected !== null}
                  onClick={() => {
                    setSelected(template);
                    setMessage('');
                  }}
                >
                  <span className="text-sm text-muted-foreground">{template.scope}: </span>
                  {template.key ?? m.curation_generic()}
                </button>
              </li>
            ))}
          </ul>
        </section>
        {selected && document ? (
          <section className="min-w-0 space-y-3" aria-label={m.curation_editor()}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="break-all font-semibold">
                {m.curation_editing({ scope: selected.scope, key: selected.key ?? m.curation_generic() })}
              </h2>
              <button type="button" className={button} onClick={() => setSelected(null)}>
                {m.curation_close()}
              </button>
            </div>
            <div className="overflow-auto rounded-xl border border-border bg-card" style={editorTheme}>
              <ClientOnly fallback={<p className="p-4">{m.curation_loading_editor()}</p>}>
                <Suspense fallback={<p className="p-4">{m.curation_loading_editor()}</p>}>
                  <PageEditor
                    key={`${selected.scope}:${selected.key}`}
                    document={document}
                    locale={getLocale()}
                    onPublish={(edited) => void publish(edited)}
                  />
                </Suspense>
              </ClientOnly>
            </div>
          </section>
        ) : (
          <>
            <form className="space-y-3 rounded-xl border border-border bg-card p-4" onSubmit={addTemplate}>
              <h2 className="font-semibold">{m.curation_add()}</h2>
              <p className="text-sm text-muted-foreground">{m.curation_add_help()}</p>
              <div className="flex flex-wrap items-end gap-3">
                <Field>
                  <FieldLabel htmlFor="curation-scope">{m.curation_scope()}</FieldLabel>
                  <NativeSelect
                    id="curation-scope"
                    value={scope}
                    onChange={(event) => setScope(event.target.value as 'type' | 'route')}
                  >
                    <NativeSelectOption value="type">{m.curation_type()}</NativeSelectOption>
                    <NativeSelectOption value="route">{m.curation_route()}</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="curation-key">{m.curation_key()}</FieldLabel>
                  <Input
                    id="curation-key"
                    className={`${control} block w-full`}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </Field>
                <button type="submit" className={button}>
                  {m.curation_add()}
                </button>
              </div>
            </form>
            <button
              type="button"
              className={button}
              disabled={publicationState.intent !== null}
              onClick={() => void publish()}
            >
              {m.curation_publish()}
            </button>
          </>
        )}
      </fieldset>
    </article>
  );
}
