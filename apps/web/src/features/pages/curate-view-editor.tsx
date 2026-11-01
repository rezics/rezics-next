import { platformRegistry, validateProfile, type CompositionDocument, type View } from '@rezics/composition';
import { ClientOnly } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import { ErrorPage } from '../../shell/shell';
import {
  overviewOf,
  profileTemplates,
  templateViewNames,
  viewOf,
  viewPointer,
  withTemplate,
  withView,
  type CurationFailure,
  type Template,
} from './curate';
import type { CurationRead } from './curate-actions';
import {
  discardPresentationDraft,
  confirmPresentationDraft,
  editView,
  hasDraftChanges,
  presentationDraft,
  reviewPresentationDraft,
  selectTemplate,
  selectionKey,
  resolveCorrection,
  currentCorrection,
  type CorrectionTarget,
} from './curate-view-editor-state';
import type { PageEditorData } from './editor-config';
import { CurationPublication, type PublicationConfirmation, type PublicationTransport } from './curation-publish';
import { CurationFailureNotice, CurationPublicationRecovery } from './curation-publish-view';
import { CurationNavigationGuard } from './curation-navigation-guard';

const PageEditor = lazy(() => import('./editor').then((module) => ({ default: module.PageEditor })));

/** The existing whole-profile publication helper owns transport; no retry protocol lives in the editor. */
export type CurationEditorTransport = PublicationTransport;
export type ObservedCurationSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
};

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

export function presentationViewNames(): Record<View, string> {
  return {
    overview: m.subject_overview(),
    editions: m.subject_editions(),
    contents: m.subject_contents(),
    characters: m.subject_characters(),
    appearances: m.subject_appearances(),
    credits: m.subject_credits(),
    works: m.subject_works(),
    relations: m.subject_relations(),
    posts: m.subject_posts(),
    reviews: m.subject_reviews(),
    discussion: m.subject_discussion(),
    lists: m.subject_lists(),
    collections: m.subject_collections(),
    details: m.subject_details(),
  };
}

type PresentationViewEditorProps = {
  initial: CurationRead;
  locale: string;
  transport: CurationEditorTransport;
  observedSession?: ObservedCurationSession;
  preview?: ReactNode;
};

type EditorLifecycle = { identity: string | null; epoch: number; reader: string | null };
type AdmissionResult = { epoch: number; reader: string; result: CurationRead };
type RetainedPublication = { publication: CurationPublication; transport: CurationEditorTransport };
type CurationReadFailure = Exclude<CurationRead, { ok: true }>;

function failureView(failure: CurationReadFailure) {
  if (failure.reason === 'forbidden') return <ErrorPage />;
  return (
    <div className="space-y-4">
      <CurationFailureNotice failure={failure} />
    </div>
  );
}

/** Admit the mounted private editor against both the same-read SSR identity and observed session changes. */
export function PresentationViewEditor({
  initial,
  locale,
  transport,
  observedSession = { state: 'unknown' },
  preview,
}: PresentationViewEditorProps) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const publications = useRef(new Map<string, RetainedPublication>());
  const [lifecycle, setLifecycle] = useState<EditorLifecycle>(() => ({
    identity: null,
    epoch: 0,
    reader: initial.ok ? initial.reader : null,
  }));
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  if (observedSession.state !== 'unknown') {
    const identity =
      observedSession.state === 'signed-in' && observedSession.subject
        ? `signed-in:${observedSession.subject}`
        : observedSession.state;
    if (lifecycle.identity === null) {
      const matchesInitial =
        observedSession.state === 'signed-in' &&
        observedSession.subject !== null &&
        observedSession.subject !== undefined &&
        initial.ok &&
        initial.reader === observedSession.subject &&
        lifecycle.epoch === 0;
      setLifecycle({
        identity,
        epoch: lifecycle.epoch + (matchesInitial ? 0 : 1),
        reader: observedSession.state === 'signed-in' ? (observedSession.subject ?? null) : null,
      });
    } else if (lifecycle.identity !== identity) {
      setLifecycle({
        identity,
        epoch: lifecycle.epoch + 1,
        reader: observedSession.state === 'signed-in' ? (observedSession.subject ?? null) : null,
      });
    }
  } else if (lifecycle.identity === null && initial.ok && initial.reader !== lifecycle.reader) {
    // A replacement same-read result is a new admission even before browser session hydration completes.
    setLifecycle({ identity: null, epoch: lifecycle.epoch + 1, reader: initial.reader });
  }

  const [admission, setAdmission] = useState<AdmissionResult | null>(null);
  const admissionRequest = useRef(0);
  const reader = lifecycle.reader;
  const initialAdmission = lifecycle.epoch === 0 && initial.ok && reader === initial.reader;
  const needsRead = lifecycle.epoch > 0 && reader !== null;
  const currentAdmission = initialAdmission
    ? initial
    : admission?.epoch === lifecycle.epoch && admission.reader === reader
      ? admission.result
      : null;

  useEffect(() => {
    if (!needsRead || !reader) return;
    let retired = false;
    const epoch = lifecycle.epoch;
    const serial = ++admissionRequest.current;
    void transportRef.current
      .read(reader)
      .then((result) => {
        if (
          retired ||
          admissionRequest.current !== serial ||
          lifecycleRef.current.epoch !== epoch ||
          lifecycleRef.current.reader !== reader
        )
          return;
        setAdmission({ epoch, reader, result });
      })
      .catch(() => {
        if (
          retired ||
          admissionRequest.current !== serial ||
          lifecycleRef.current.epoch !== epoch ||
          lifecycleRef.current.reader !== reader
        )
          return;
        setAdmission({ epoch, reader, result: { ok: false, reason: 'unavailable' } });
      });
    return () => {
      retired = true;
      if (admissionRequest.current === serial) admissionRequest.current += 1;
    };
  }, [lifecycle.epoch, needsRead, reader]);

  function retryAdmission() {
    if (!needsRead || !reader) return;
    const epoch = lifecycle.epoch;
    const serial = ++admissionRequest.current;
    void transportRef.current
      .read(reader)
      .then((result) => {
        if (
          admissionRequest.current === serial &&
          lifecycleRef.current.epoch === epoch &&
          lifecycleRef.current.reader === reader
        )
          setAdmission({ epoch, reader, result });
      })
      .catch(() => {
        if (
          admissionRequest.current === serial &&
          lifecycleRef.current.epoch === epoch &&
          lifecycleRef.current.reader === reader
        )
          setAdmission({ epoch, reader, result: { ok: false, reason: 'unavailable' } });
      });
  }

  if (observedSession.state === 'signed-out') return failureView({ ok: false, reason: 'signed-out' });
  if (observedSession.state === 'unavailable') return failureView({ ok: false, reason: 'unavailable' });
  if (observedSession.state === 'signed-in' && !reader) return failureView({ ok: false, reason: 'forbidden' });
  if (!reader && observedSession.state === 'unknown')
    return !initial.ok ? failureView(initial) : failureView({ ok: false, reason: 'forbidden' });
  if (!currentAdmission) {
    if (!needsRead) return !initial.ok ? failureView(initial) : failureView({ ok: false, reason: 'unavailable' });
    return <p role="status">{m.curation_loading()}</p>;
  }
  if (!currentAdmission.ok)
    return currentAdmission.reason === 'unavailable' && needsRead ? (
      <div className="space-y-4">
        {failureView(currentAdmission)}
        <Button onClick={retryAdmission}>{m.curation_reload()}</Button>
      </div>
    ) : (
      failureView(currentAdmission)
    );
  if (currentAdmission.reader !== reader) return failureView({ ok: false, reason: 'forbidden' });

  let retained = publications.current.get(reader);
  if (!retained) {
    const publicationTransport: CurationEditorTransport = {
      publish: (intent, expectedReader) => transportRef.current.publish(intent, expectedReader),
      read: (expectedReader) => transportRef.current.read(expectedReader),
    };
    retained = { publication: new CurationPublication(reader, publicationTransport), transport: publicationTransport };
    publications.current.set(reader, retained);
  }
  return (
    <AdmittedPresentationViewEditor
      key={`${lifecycle.epoch}:${reader}`}
      initial={currentAdmission}
      locale={locale}
      reader={reader}
      epoch={lifecycle.epoch}
      transportRef={transportRef}
      retained={retained}
      preview={preview}
    />
  );
}

function AdmittedPresentationViewEditor({
  initial,
  locale,
  reader,
  epoch,
  transportRef,
  retained,
  preview,
}: {
  initial: Extract<CurationRead, { ok: true }>;
  locale: string;
  reader: string;
  epoch: number;
  transportRef: { current: CurationEditorTransport };
  retained: RetainedPublication;
  preview?: ReactNode;
}) {
  const [current, setCurrent] = useState<CurationRead>(initial);
  const [draft, setDraft] = useState(() => (initial.ok ? presentationDraft(initial) : null));
  const [failure, setFailure] = useState<CurationFailure | null>(null);
  const [failureProfile, setFailureProfile] = useState(initial.ok ? initial.profile : null);
  const [message, setMessage] = useState('');
  const [loadingProfile, setLoadingProfile] = useState(false);
  const publication = retained.publication;
  const lifetime = useRef({ active: false, epoch });
  lifetime.current.epoch = epoch;
  const isCurrent = () => lifetime.current.active && lifetime.current.epoch === epoch;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  useLayoutEffect(() => {
    lifetime.current.active = true;
    publication.activate(retained.transport);
    return () => {
      lifetime.current.active = false;
      publication.retire();
    };
  }, [epoch, publication, retained]);
  const publicationState = useSyncExternalStore(
    publication.subscribe,
    publication.getSnapshot,
    publication.getSnapshot,
  );
  const busy = loadingProfile || publicationState.busy;
  const pendingPublication = publicationState.intent !== null;
  const inFlight = useRef(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirm, setConfirm] = useState<'discard' | 'reload' | null>(null);
  const [generation, setGeneration] = useState(0);
  const [scope, setScope] = useState<'type' | 'route'>('type');
  const [key, setKey] = useState('');
  const [correction, setCorrection] = useState<CorrectionTarget | null>(null);
  const editorRegion = useRef<HTMLElement>(null);
  const pageRegion = useRef<HTMLElement>(null);
  const [focusRegion, setFocusRegion] = useState(0);
  useEffect(() => {
    if (focusRegion && isCurrent()) editorRegion.current?.focus();
  }, [focusRegion]);
  const dirty = useMemo(() => draft !== null && hasDraftChanges(draft), [draft]);
  const initialVersion = `${initial.reader}:${initial.digest}:${initial.head}`;
  const previousInitial = useRef(initialVersion);
  useEffect(() => {
    if (previousInitial.current === initialVersion) return;
    previousInitial.current = initialVersion;
    if (!isCurrent() || dirty || publication.getSnapshot().intent) return;
    setCurrent(initial);
    setDraft(presentationDraft(initial));
    setFailure(null);
    setFailureProfile(initial.profile);
    setCorrection(null);
    setMessage('');
    setGeneration((value) => value + 1);
  }, [initialVersion]);
  const navigationGuard = (
    <CurationNavigationGuard dirty={dirty} retainedPublication={pendingPublication} fallbackFocus={pageRegion} />
  );
  const viewNames = presentationViewNames();
  const scopeNames = {
    generic: m.curation_generic(),
    base: m.curation_base(),
    type: m.curation_type(),
    route: m.curation_route(),
  };
  const templateLabel = (template: Template) =>
    template.key === null ? scopeNames.generic : `${scopeNames[template.scope]}: ${template.key}`;
  const invalidPublication = publicationState.result?.ok === false && publicationState.result.reason === 'invalid';
  const admissionFailure =
    (publicationState.result?.ok === false &&
      publicationState.result.reason === 'forbidden' &&
      publicationState.result.admissionChanged &&
      publicationState.result) ||
    (publicationState.readFailure?.reason === 'signed-out' && publicationState.readFailure) ||
    (publicationState.readFailure?.reason === 'forbidden' &&
      publicationState.readFailure.admissionChanged &&
      publicationState.readFailure);
  const laterChanges =
    !!draft &&
    !!publicationState.intent &&
    JSON.stringify(draft.profile) !== JSON.stringify(publicationState.intent.profile);
  const unresolvedPublication = pendingPublication && !invalidPublication;

  if (admissionFailure)
    return (
      <>
        <CurationNavigationGuard dirty={false} retainedPublication={pendingPublication} fallbackFocus={pageRegion} />
        <CurationFailureNotice failure={admissionFailure} />
      </>
    );

  function validationCorrection(source: typeof failureProfile) {
    return {
      describe(pointer: string) {
        const target = source && resolveCorrection(source, pointer, localeRef.current);
        return target
          ? m.curation_correction_target({
              template: templateLabel(target.template),
              view: viewNames[target.view],
              component: target.component?.type ?? m.curation_page_settings(),
              field: target.label,
            })
          : m.curation_correction_unknown();
      },
      correct(pointer: string) {
        if (!isCurrent() || !draft || busy) return;
        const original = source && resolveCorrection(source, pointer, localeRef.current);
        const target = original && currentCorrection(draft.profile, original);
        setEditorOpen(true);
        setCorrection(target ? { ...target } : null);
        setMessage(
          target
            ? source && JSON.stringify(source) !== JSON.stringify(draft.profile)
              ? m.curation_correction_later()
              : m.curation_correction_help()
            : original
              ? m.curation_correction_missing()
              : m.curation_correction_unknown(),
        );
        if (target)
          setDraft((value) => value && { ...value, selection: { template: target.template, view: target.view } });
        else setFocusRegion((value) => value + 1);
      },
    };
  }

  if ((!current.ok && current.reason === 'forbidden') || failure?.reason === 'forbidden')
    return (
      <>
        {navigationGuard}
        <ErrorPage />
      </>
    );

  async function reload() {
    if (!isCurrent() || inFlight.current) return;
    if (publication.getSnapshot().intent) {
      await publication.inspect();
      return;
    }
    inFlight.current = true;
    setLoadingProfile(true);
    setFailure(null);
    setCorrection(null);
    setMessage('');
    try {
      const next = await transportRef.current.read(reader);
      if (!isCurrent()) return;
      if (next.ok) {
        if (next.reader !== reader) {
          setCurrent({ ok: false, reason: 'forbidden' });
          setDraft(null);
          return;
        }
        setCurrent(next);
        setDraft(presentationDraft(next));
        setGeneration((value) => value + 1);
        setMessage(m.curation_reloaded());
      } else if (next.reason === 'signed-out') {
        setCurrent(next);
        setDraft(null);
      } else setFailure(next);
    } catch {
      if (!isCurrent()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setLoadingProfile(false);
      }
    }
  }

  function change(data: PageEditorData) {
    if (!isCurrent() || !draft || inFlight.current) return;
    const selection = draft.selection;
    setDraft((value) => value && editView(value, selection, data));
    setFailure(null);
    if (!correction) setMessage('');
  }

  function addTemplate(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy) return;
    const template = { scope, key };
    if (profileTemplates(draft.profile).some((item) => item.scope === scope && item.key === key)) {
      setFailure({
        ok: false,
        reason: 'invalid',
        errors: [{ pointer: `/${scope === 'type' ? 'types' : 'routes'}`, code: 'duplicate' }],
      });
      return;
    }
    const profile = withTemplate(
      draft.profile,
      template,
      structuredClone(overviewOf(draft.profile, { scope: 'generic', key: null })!),
    );
    const errors = validateProfile(platformRegistry, profile);
    if (errors.length) {
      setFailure({ ok: false, reason: 'invalid', errors });
      setFailureProfile(profile);
      return;
    }
    setDraft({ ...draft, profile, selection: { template, view: 'overview' } });
    setEditorOpen(true);
    setKey('');
    setFailure(null);
    setMessage(m.curation_added());
  }

  function published(confirmation: PublicationConfirmation) {
    if (!isCurrent() || confirmation.intent.reader !== reader) return;
    const saved = { reader, profile: confirmation.intent.profile, ...confirmation.result };
    setCurrent(saved);
    setDraft((value) => value && confirmPresentationDraft(value, confirmation));
    setCorrection(null);
    setMessage('');
  }

  async function publish(edited?: CompositionDocument) {
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy || unresolvedPublication) return;
    // onChange normally already captured this data; onPublish can deliver a final synchronous edit.
    const profile = edited
      ? withView(draft.profile, draft.selection.template, draft.selection.view, edited)
      : draft.profile;
    const errors = validateProfile(platformRegistry, profile);
    if (errors.length) {
      setFailure({ ok: false, reason: 'invalid', errors });
      setFailureProfile(profile);
      return;
    }
    setDraft((value) => value && { ...value, profile });
    setFailure(null);
    setMessage('');
    const confirmation = invalidPublication
      ? await publication.replaceInvalid(profile, draft.saved.head)
      : await publication.start(profile, draft.saved.head);
    if (isCurrent() && confirmation) published(confirmation);
  }

  if (!draft)
    return (
      <div className="space-y-4">
        {navigationGuard}
        <CurationFailureNotice failure={failure ?? (current.ok ? { ok: false, reason: 'unavailable' } : current)} />
        <Button disabled={busy} onClick={() => void reload()}>
          {m.curation_reload()}
        </Button>
      </div>
    );

  const { profile, selection, editors, saved } = draft;
  const templates = profileTemplates(profile);
  const views = templateViewNames(profile, selection.template);
  const document = viewOf(profile, selection.template, selection.view)!;
  const editorKey = selectionKey(selection);
  const loading = (
    <p className="p-4" role="status">
      {m.curation_loading()}
    </p>
  );

  return (
    <article ref={pageRegion} tabIndex={-1} className="min-w-0 space-y-6 font-sans text-foreground" aria-busy={busy}>
      {navigationGuard}
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{m.curation_heading()}</h1>
        <p className="text-muted-foreground">{m.presentation_editor_draft_summary()}</p>
        <p className="text-sm text-muted-foreground">{m.curation_instructions()}</p>
        <p role="status" className="text-sm">
          {invalidPublication && pendingPublication
            ? laterChanges && dirty
              ? m.curation_invalid_later()
              : m.curation_invalid_retained()
            : dirty
              ? m.curation_unsaved()
              : m.curation_saved()}
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {m.presentation_editor_saved_version_details()}
          </summary>
          <p className="mt-2 break-all font-mono">
            {m.presentation_editor_version_reference({ head: saved.head, digest: saved.digest })}
          </p>
        </details>
      </header>
      {message && (
        <p role="status" className="rounded-lg border border-border bg-card p-4">
          {message}
        </p>
      )}
      {failure && <CurationFailureNotice failure={failure} correction={validationCorrection(failureProfile)} />}
      {preview}
      <CurationPublicationRecovery
        publication={publication}
        profile={profile}
        head={saved.head}
        onPublished={published}
        correction={validationCorrection(publicationState.intent?.profile ?? profile)}
        onReviewed={(_reviewed, choice) => {
          if (!isCurrent()) return;
          // reconcile('keep') returns the draft on the reviewed head. The dirty baseline is the actual read.
          const active = publicationState.active;
          if (!active) return;
          setCurrent(active);
          setDraft((value) => value && reviewPresentationDraft(value, active, choice));
          if (choice === 'discard') setGeneration((value) => value + 1);
          setFailure(null);
          setMessage(choice === 'keep' ? m.curation_reconciled() : m.curation_discarded());
        }}
      />
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="flex flex-wrap gap-3">
          {!editorOpen && (
            <Button
              disabled={unresolvedPublication || (invalidPublication && !laterChanges)}
              onClick={() => void publish()}
            >
              {m.curation_publish()}
            </Button>
          )}
          <Button variant="outline" disabled={!dirty} onClick={() => isCurrent() && setConfirm('discard')}>
            {m.curation_view_discard()}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              isCurrent() && (!pendingPublication && dirty ? setConfirm('reload') : void reload())
            }
          >
            {m.curation_reload()}
          </Button>
        </div>
        <section
          className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
          aria-label={m.curation_templates()}
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field className="min-w-0">
              <FieldLabel htmlFor="curation-template">{m.curation_template()}</FieldLabel>
              <NativeSelect
                id="curation-template"
                value={JSON.stringify(selection.template)}
                onChange={(event) => {
                  if (!isCurrent()) return;
                  const template = templates.find((item) => JSON.stringify(item) === event.target.value);
                  if (template) {
                    setCorrection(null);
                    setDraft((value) => value && selectTemplate(value, template));
                    setEditorOpen(true);
                  }
                }}
              >
                {templates.map((template) => (
                  <NativeSelectOption key={JSON.stringify(template)} value={JSON.stringify(template)}>
                    {templateLabel(template)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor="curation-view">{m.curation_view()}</FieldLabel>
              <NativeSelect
                id="curation-view"
                value={selection.view}
                onChange={(event) => {
                  if (!isCurrent()) return;
                  const view = views.find((item) => item === event.target.value);
                  if (view) {
                    setCorrection(null);
                    setDraft((value) => value && { ...value, selection: { ...value.selection, view } });
                    setEditorOpen(true);
                  }
                }}
              >
                {views.map((view) => (
                  <NativeSelectOption key={view} value={view}>
                    {viewNames[view]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {m.presentation_editor_resolver_details()}
            </summary>
            <p className="mt-2 text-muted-foreground">{m.curation_fallback()}</p>
          </details>
        </section>
        {editorOpen ? (
          <section ref={editorRegion} tabIndex={-1} className="min-w-0 space-y-3" aria-label={m.curation_editor()}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="break-words font-semibold">
                {templateLabel(selection.template)} · {viewNames[selection.view]}
              </h2>
              <Button variant="outline" onClick={() => isCurrent() && setEditorOpen(false)}>
                {m.curation_close()}
              </Button>
            </div>
            <div
              className="overflow-auto rounded-xl border border-border bg-card [&_h1]:font-sans"
              style={editorTheme}
              inert={busy}
            >
              <ClientOnly fallback={loading}>
                <Suspense fallback={loading}>
                  <PageEditor
                    key={`${generation}:${editorKey}`}
                    document={document}
                    draft={editors[editorKey]}
                    locale={locale}
                    pointerPrefix={viewPointer(profile, selection.template, selection.view)}
                    publishDisabled={unresolvedPublication || busy || (invalidPublication && !laterChanges)}
                    correction={correction}
                    onInvalid={(errors, document) => {
                      if (!isCurrent()) return;
                      const invalid = withView(profile, selection.template, selection.view, document);
                      setFailure({
                        ok: false,
                        reason: 'invalid',
                        errors: errors.map((error) => ({
                          ...error,
                          pointer: viewPointer(profile, selection.template, selection.view) + error.pointer,
                        })),
                      });
                      setFailureProfile(invalid);
                    }}
                    onChange={change}
                    onPublish={(edited) => void publish(edited)}
                  />
                </Suspense>
              </ClientOnly>
            </div>
          </section>
        ) : (
          <Button variant="outline" onClick={() => isCurrent() && setEditorOpen(true)}>
            {selection.template.scope}: {selection.template.key ?? m.curation_generic()}
          </Button>
        )}
        <form className="space-y-3 rounded-xl border border-border bg-card p-4" onSubmit={addTemplate}>
          <h2 className="font-semibold">{m.curation_add()}</h2>
          <p className="text-sm text-muted-foreground">{m.curation_add_hint()}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field>
              <FieldLabel htmlFor="curation-scope">{m.curation_scope()}</FieldLabel>
              <NativeSelect
                id="curation-scope"
                value={scope}
                onChange={(event) => isCurrent() && setScope(event.target.value as 'type' | 'route')}
              >
                <NativeSelectOption value="type">{scopeNames.type}</NativeSelectOption>
                <NativeSelectOption value="route">{scopeNames.route}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="curation-key">{m.curation_key()}</FieldLabel>
              <Input
                id="curation-key"
                value={key}
                onChange={(event) => isCurrent() && setKey(event.target.value)}
                required
                autoComplete="off"
              />
            </Field>
            <Button type="submit" variant="outline">
              {m.curation_add()}
            </Button>
          </div>
        </form>
      </fieldset>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.curation_discard_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'reload' ? m.curation_reload_warning() : m.curation_discard_warning()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.curation_keep()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!isCurrent()) return;
                if (confirm === 'reload') void reload();
                else {
                  setDraft((value) => value && discardPresentationDraft(value));
                  setGeneration((value) => value + 1);
                  setCorrection(null);
                  setFailure(null);
                  setMessage(m.curation_view_discarded());
                }
                setConfirm(null);
              }}
            >
              {confirm === 'reload' ? m.curation_discard_reload() : m.curation_view_discard()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
