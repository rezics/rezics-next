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
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
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
import {
  CurationPublication,
  retainedCurationPublication,
  type CurationPublicationVisit,
  type PublicationConfirmation,
  type PublicationTransport,
} from './curation-publish';
import {
  type CurationAdmissionLease,
  CurationReaderAdmission,
} from './curation-reader-admission';
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
  admission?: CurationReaderAdmission;
  preview?: ReactNode;
};

type EditorLifecycle = { identity: string | null; epoch: number; reader: string | null };
type AdmissionResult = { epoch: number; reader: string; result: CurationRead };
type RetainedPublication = { publication: CurationPublication; transport: CurationEditorTransport };
type CurationReadFailure = Exclude<CurationRead, { ok: true }>;
type FreshAdmissionResult = {
  reader: string;
  version: number;
  result: CurationRead;
  lease?: CurationAdmissionLease;
};

type AdmissionReadRequest = { reader: string; version: number; promise: Promise<CurationRead> };

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
  ...props
}: PresentationViewEditorProps) {
  if (props.admission) return <ActualPresentationViewEditor {...props} admission={props.admission} />;
  return <StandalonePresentationViewEditor {...props} />;
}

function ActualPresentationViewEditor({
  initial,
  locale,
  transport,
  admission,
  preview,
}: PresentationViewEditorProps & { admission: CurationReaderAdmission }) {
  const snapshot = useSyncExternalStore(admission.subscribe, admission.getSnapshot, admission.getSnapshot);
  const lease = snapshot.lease;
  const reader = lease?.reader ?? (snapshot.session.state === 'signed-in' ? (snapshot.session.subject ?? null) : null);
  const initialRead = useRef<{
    lease: CurationAdmissionLease;
    result: Extract<CurationRead, { ok: true }>;
  } | null>(null);
  if (lease?.kind === 'initial' && initial.ok && initial.reader === lease.reader)
    initialRead.current = { lease, result: initial };
  const initialAdmission =
    lease?.kind === 'initial' && initialRead.current?.lease === lease ? initialRead.current.result : null;
  const [freshResult, setFreshResult] = useState<FreshAdmissionResult | null>(null);
  const retainedPublication = useRef<RetainedPublication | null>(null);
  const readRequest = useRef<AdmissionReadRequest | null>(null);

  const readCurrent = (expectedReader: string, version: number, invocationTransport: CurationEditorTransport) => {
    if (!admission.canRead(expectedReader, version)) return () => {};

    let request = readRequest.current;
    if (!request || request.reader !== expectedReader || request.version !== version) {
      const promise = Promise.resolve().then(() =>
        admission.canRead(expectedReader, version)
          ? invocationTransport.read(expectedReader)
          : ({ ok: false, reason: 'unavailable' } as const),
      );
      request = { reader: expectedReader, version, promise };
      readRequest.current = request;
      void promise.then(
        () => {
          if (readRequest.current === request) readRequest.current = null;
        },
        () => {
          if (readRequest.current === request) readRequest.current = null;
        },
      );
    }

    let live = true;
    request.promise.then(
      (result) => {
        if (!live || !admission.canRead(expectedReader, version)) return;
        if (result.ok) {
          if (result.reader !== expectedReader) {
            const refusal = { ok: false as const, reason: 'forbidden' as const, admissionChanged: true };
            setFreshResult((previous) =>
              admission.canRead(expectedReader, version) ? { reader: expectedReader, version, result: refusal } : previous,
            );
            return;
          }
          const newLease = admission.admitFresh(expectedReader, version);
          if (!newLease) return;
          setFreshResult((previous) =>
            newLease.isCurrent() ? { reader: expectedReader, version, result, lease: newLease } : previous,
          );
          return;
        }
        setFreshResult((previous) =>
          admission.canRead(expectedReader, version) ? { reader: expectedReader, version, result } : previous,
        );
      },
      () => {
        if (!live || !admission.canRead(expectedReader, version)) return;
        setFreshResult((previous) =>
          admission.canRead(expectedReader, version)
            ? { reader: expectedReader, version, result: { ok: false, reason: 'unavailable' } }
            : previous,
        );
      },
    );
    return () => {
      live = false;
    };
  };

  const needsRead = !lease && reader !== null;
  useEffect(() => {
    if (!needsRead || !reader) return;
    const invocationTransport = transport;
    return readCurrent(reader, snapshot.version, invocationTransport);
  }, [admission, needsRead, reader, snapshot.version]);

  function retryAdmission() {
    if (!needsRead || !reader) return;
    const invocationTransport = transport;
    readCurrent(reader, snapshot.version, invocationTransport);
  }

  const currentFreshAdmission =
    lease?.kind === 'fresh' && freshResult?.lease === lease ? freshResult.result : null;
  const currentAdmission = initialAdmission ?? currentFreshAdmission;

  if (snapshot.session.state === 'signed-out') return failureView({ ok: false, reason: 'signed-out' });
  if (snapshot.session.state === 'unavailable') return failureView({ ok: false, reason: 'unavailable' });
  if (snapshot.session.state === 'signed-in' && !reader) return failureView({ ok: false, reason: 'forbidden' });
  if (!reader && snapshot.session.state === 'unknown')
    return initial.ok && lease?.kind === 'initial'
      ? failureView({ ok: false, reason: 'unavailable' })
      : !initial.ok
        ? failureView(initial)
        : failureView({ ok: false, reason: 'unavailable' });

  if (!currentAdmission) {
    const failedRead =
      needsRead &&
      freshResult?.reader === reader &&
      freshResult.version === snapshot.version &&
      !freshResult.lease &&
      !freshResult.result.ok
        ? freshResult.result
        : null;
    if (failedRead)
      return failedRead.reason === 'unavailable' ? (
        <div className="space-y-4">
          {failureView(failedRead)}
          <Button onClick={retryAdmission}>{m.curation_reload()}</Button>
        </div>
      ) : (
        failureView(failedRead)
      );
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
  if (!lease) return failureView({ ok: false, reason: 'unavailable' });

  let retained = retainedPublication.current;
  if (!retained || retained.publication.reader !== reader) {
    retained = { publication: retainedCurationPublication(reader!, transport), transport };
    retainedPublication.current = retained;
  }
  retained.transport = transport;
  retained.publication.setTransport(transport);
  return (
    <AdmittedPresentationViewEditor
      key={`${lease.incarnation}:${reader}`}
      initial={currentAdmission}
      locale={locale}
      reader={reader!}
      epoch={lease.incarnation}
      lease={lease}
      transport={transport}
      retained={retained}
      preview={preview}
    />
  );
}

function StandalonePresentationViewEditor({
  initial,
  locale,
  transport,
  observedSession = { state: 'unknown' },
  preview,
}: PresentationViewEditorProps) {
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
    const invocationTransport = transport;
    void invocationTransport
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
    const invocationTransport = transport;
    void invocationTransport
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
    retained = { publication: new CurationPublication(reader, transport), transport };
    publications.current.set(reader, retained);
  }
  retained.transport = transport;
  retained.publication.setTransport(transport);
  return (
    <AdmittedPresentationViewEditor
      key={`${lifecycle.epoch}:${reader}`}
      initial={currentAdmission}
      locale={locale}
      reader={reader}
      epoch={lifecycle.epoch}
      transport={transport}
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
  lease,
  transport,
  retained,
  preview,
}: {
  initial: Extract<CurationRead, { ok: true }>;
  locale: string;
  reader: string;
  epoch: number;
  lease?: CurationAdmissionLease;
  transport: CurationEditorTransport;
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
  const [visit, setVisit] = useState<CurationPublicationVisit | null>(null);
  const isCurrent = () =>
    lifetime.current.active &&
    lifetime.current.epoch === epoch &&
    (!lease || lease.isCurrent()) &&
    !!visit?.isCurrent();
  function setOwned<T>(setter: Dispatch<SetStateAction<T>>, update: NoInfer<SetStateAction<T>>) {
    setter((previous) => {
      if (!isCurrent()) return previous;
      return typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
    });
  }
  const localeRef = useRef(locale);
  localeRef.current = locale;
  useLayoutEffect(() => {
    if (lease && !lease.isCurrent()) return;
    lifetime.current.active = true;
    const currentVisit = publication.activate(transport, lease ?? null);
    setVisit((previous) => (currentVisit.isCurrent() ? currentVisit : previous));
    return () => {
      lifetime.current.active = false;
      publication.retire(currentVisit);
    };
  }, [epoch, publication, retained, lease]);
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
    setOwned(setCurrent, initial);
    setOwned(setDraft, presentationDraft(initial));
    setOwned(setFailure, null);
    setOwned(setFailureProfile, initial.profile);
    setOwned(setCorrection, null);
    setOwned(setMessage, '');
    setOwned(setGeneration, (value) => value + 1);
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
        setOwned(setEditorOpen, true);
        setOwned(setCorrection, target ? { ...target } : null);
        setOwned(setMessage,
          target
            ? source && JSON.stringify(source) !== JSON.stringify(draft.profile)
              ? m.curation_correction_later()
              : m.curation_correction_help()
            : original
              ? m.curation_correction_missing()
              : m.curation_correction_unknown(),
        );
        if (target)
          setOwned(setDraft, (value) => value && { ...value, selection: { template: target.template, view: target.view } });
        else setOwned(setFocusRegion, (value) => value + 1);
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
      const currentVisit = visit;
      if (!currentVisit?.isCurrent()) return;
      await currentVisit.inspect();
      if (!isCurrent() || !currentVisit.isCurrent()) return;
      return;
    }
    const invocationTransport = transport;
    inFlight.current = true;
    setOwned(setLoadingProfile, true);
    setOwned(setFailure, null);
    setOwned(setCorrection, null);
    setOwned(setMessage, '');
    try {
      const next = await invocationTransport.read(reader);
      if (!isCurrent()) return;
      if (next.ok) {
        if (next.reader !== reader) {
          setOwned(setCurrent, { ok: false, reason: 'forbidden' });
          setOwned(setDraft, null);
          return;
        }
        setOwned(setCurrent, next);
        setOwned(setDraft, presentationDraft(next));
        setOwned(setGeneration, (value) => value + 1);
        setOwned(setMessage, m.curation_reloaded());
      } else if (next.reason === 'signed-out') {
        setOwned(setCurrent, next);
        setOwned(setDraft, null);
      } else setOwned(setFailure, next);
    } catch {
      if (!isCurrent()) return;
      setOwned(setFailure, { ok: false, reason: 'unavailable' });
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setOwned(setLoadingProfile, false);
      }
    }
  }

  function change(data: PageEditorData) {
    if (!isCurrent() || !draft || inFlight.current) return;
    const selection = draft.selection;
    setOwned(setDraft, (value) => value && editView(value, selection, data));
    setOwned(setFailure, null);
    if (!correction) setOwned(setMessage, '');
  }

  function addTemplate(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy) return;
    const template = { scope, key };
    if (profileTemplates(draft.profile).some((item) => item.scope === scope && item.key === key)) {
      setOwned(setFailure, {
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
      setOwned(setFailure, { ok: false, reason: 'invalid', errors });
      setOwned(setFailureProfile, profile);
      return;
    }
    setOwned(setDraft, { ...draft, profile, selection: { template, view: 'overview' } });
    setOwned(setEditorOpen, true);
    setOwned(setKey, '');
    setOwned(setFailure, null);
    setOwned(setMessage, m.curation_added());
  }

  function published(confirmation: PublicationConfirmation) {
    if (!isCurrent() || confirmation.intent.reader !== reader) return;
    const saved = { reader, profile: confirmation.intent.profile, ...confirmation.result };
    setOwned(setCurrent, saved);
    setOwned(setDraft, (value) => value && confirmPresentationDraft(value, confirmation));
    setOwned(setCorrection, null);
    setOwned(setMessage, '');
  }

  async function publish(edited?: CompositionDocument) {
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy || unresolvedPublication) return;
    // onChange normally already captured this data; onPublish can deliver a final synchronous edit.
    const profile = edited
      ? withView(draft.profile, draft.selection.template, draft.selection.view, edited)
      : draft.profile;
    const errors = validateProfile(platformRegistry, profile);
    if (errors.length) {
      setOwned(setFailure, { ok: false, reason: 'invalid', errors });
      setOwned(setFailureProfile, profile);
      return;
    }
    setOwned(setDraft, (value) => value && { ...value, profile });
    setOwned(setFailure, null);
    setOwned(setMessage, '');
    const currentVisit = visit;
    if (!currentVisit?.isCurrent()) return;
    const confirmation = invalidPublication
      ? await currentVisit.replaceInvalid(profile, draft.saved.head)
      : await currentVisit.start(profile, draft.saved.head);
    if (isCurrent() && currentVisit.isCurrent() && confirmation) published(confirmation);
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
        visit={visit ?? undefined}
        profile={profile}
        head={saved.head}
        onPublished={published}
        correction={validationCorrection(publicationState.intent?.profile ?? profile)}
        onReviewed={(_reviewed, choice) => {
          if (!isCurrent()) return;
          // reconcile('keep') returns the draft on the reviewed head. The dirty baseline is the actual read.
          const active = publicationState.active;
          if (!active) return;
          setOwned(setCurrent, active);
          setOwned(setDraft, (value) => value && reviewPresentationDraft(value, active, choice));
          if (choice === 'discard') setOwned(setGeneration, (value) => value + 1);
          setOwned(setFailure, null);
          setOwned(setMessage, choice === 'keep' ? m.curation_reconciled() : m.curation_discarded());
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
          <Button variant="outline" disabled={!dirty} onClick={() => isCurrent() && setOwned(setConfirm, 'discard')}>
            {m.curation_view_discard()}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              isCurrent() && (!pendingPublication && dirty ? setOwned(setConfirm, 'reload') : void reload())
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
                    setOwned(setCorrection, null);
                    setOwned(setDraft, (value) => value && selectTemplate(value, template));
                    setOwned(setEditorOpen, true);
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
                    setOwned(setCorrection, null);
                    setOwned(setDraft, (value) => value && { ...value, selection: { ...value.selection, view } });
                    setOwned(setEditorOpen, true);
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
              <Button variant="outline" onClick={() => isCurrent() && setOwned(setEditorOpen, false)}>
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
                      setOwned(setFailure, {
                        ok: false,
                        reason: 'invalid',
                        errors: errors.map((error) => ({
                          ...error,
                          pointer: viewPointer(profile, selection.template, selection.view) + error.pointer,
                        })),
                      });
                      setOwned(setFailureProfile, invalid);
                    }}
                    onChange={change}
                    onPublish={(edited) => void publish(edited)}
                  />
                </Suspense>
              </ClientOnly>
            </div>
          </section>
        ) : (
          <Button variant="outline" onClick={() => isCurrent() && setOwned(setEditorOpen, true)}>
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
                onChange={(event) => isCurrent() && setOwned(setScope, event.target.value as 'type' | 'route')}
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
                onChange={(event) => isCurrent() && setOwned(setKey, event.target.value)}
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
          if (!open && isCurrent()) setOwned(setConfirm, null);
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
                  setOwned(setDraft, (value) => value && discardPresentationDraft(value));
                  setOwned(setGeneration, (value) => value + 1);
                  setOwned(setCorrection, null);
                  setOwned(setFailure, null);
                  setOwned(setMessage, m.curation_view_discarded());
                }
                setOwned(setConfirm, null);
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
