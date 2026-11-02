import { platformRegistry, validateProfile, type CompositionDocument, type View } from '@rezics/composition';
import { ClientOnly } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
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
  addCompanionView,
  overviewOf,
  profileTemplates,
  resetCompanionView,
  templateViewNames,
  viewOf,
  viewPointer,
  withTemplate,
  withView,
  type CompanionViewSource,
  type CurationFailure,
  type Template,
} from './curate';
import { addStructuralBaseTemplate } from './curation-base-template';
import type { CurationRead } from './curate-actions';
import {
  discardPresentationDraft,
  confirmPresentationDraft,
  draftPublicationProfile,
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
import { type CurationAdmissionLease, CurationReaderAdmission } from './curation-reader-admission';
import {
  canDispatchCurationRead,
  retireCurationReadWait,
  useCurationReadWait,
  waitAfterCurationRead,
} from './curation-read-retry';
import { CurationFailureNotice, CurationPublicationRecovery } from './curation-publish-view';
import { CurationNavigationGuard } from './curation-navigation-guard';
import { presentationMessageOptions } from './curate-view-editor-messages';
import {
  confirmKeyedTemplateRemoval,
  keyedTemplateRemovalApplies,
  reviewKeyedTemplateRemoval,
  type KeyedTemplate,
  type KeyedTemplateRemoval,
} from './curation-template-removal';
import { CurationCompanionViews } from './curation-companion-views';

const PageEditor = lazy(() => import('./editor').then((module) => ({ default: module.PageEditor })));

const editorControlClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const editorDisclosureClass =
  'min-h-11 min-w-11 cursor-pointer rounded-md py-2 text-muted-foreground [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
// Scope consumer styling to editor-owned recovery, leaving the supplied preview and Puck untouched.
const editorRecoveryClass =
  'contents [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:[overflow-wrap:anywhere] [&_summary]:min-h-11 [&_summary]:min-w-11 [&_summary]:cursor-pointer [&_summary]:rounded-md [&_summary]:py-2 [&_summary]:[overflow-wrap:anywhere] [&_summary]:focus-visible:outline-none [&_summary]:focus-visible:ring-2 [&_summary]:focus-visible:ring-ring [&_summary]:focus-visible:ring-offset-2 [&_pre]:focus-visible:ring-2 [&_pre]:focus-visible:ring-ring';

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

export function presentationViewNames(locale?: string): Record<View, string> {
  const options = presentationMessageOptions(locale);
  return {
    overview: m.subject_overview({}, options),
    editions: m.subject_editions({}, options),
    contents: m.subject_contents({}, options),
    characters: m.subject_characters({}, options),
    appearances: m.subject_appearances({}, options),
    credits: m.subject_credits({}, options),
    works: m.subject_works({}, options),
    relations: m.subject_relations({}, options),
    posts: m.subject_posts({}, options),
    reviews: m.subject_reviews({}, options),
    discussion: m.subject_discussion({}, options),
    lists: m.subject_lists({}, options),
    collections: m.subject_collections({}, options),
    details: m.subject_details({}, options),
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

type AdmissionReadRequest = { reader: string; version: number; promise: Promise<CurationRead | undefined> };

function failureView(failure: CurationReadFailure, locale: string) {
  if (failure.reason === 'forbidden') return <ErrorPage />;
  return (
    <div className="space-y-4">
      <CurationFailureNotice failure={failure} locale={locale} />
    </div>
  );
}

function retryableReadFailure(
  failure: CurationReadFailure,
  locale: string,
  retry?: { waiting: boolean; onRetry: () => void },
) {
  const retryable = failure.reason === 'unavailable' || failure.reason === 'rate-limited';
  if (!retryable || !retry) return failureView(failure, locale);
  const options = presentationMessageOptions(locale);
  return (
    <div className="space-y-4">
      {failureView(failure, locale)}
      <Button className={editorControlClass} disabled={retry.waiting} onClick={retry.onRetry}>
        {m.curation_reload({}, options)}
      </Button>
    </div>
  );
}

/** Admit the mounted private editor against both the same-read SSR identity and observed session changes. */
export function PresentationViewEditor({ ...props }: PresentationViewEditorProps) {
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
  const options = presentationMessageOptions(locale);
  const snapshot = useSyncExternalStore(admission.subscribe, admission.getSnapshot, admission.getSnapshot);
  const lease = snapshot.lease;
  const reader = lease?.reader ?? (snapshot.session.state === 'signed-in' ? (snapshot.session.subject ?? null) : null);
  const waitOwner = reader ? { reader, generation: snapshot.version } : null;
  const { waitRef, waiting, replaceWait } = useCurationReadWait(waitOwner);
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
    const owner = { reader: expectedReader, generation: version };
    if (!canDispatchCurationRead(waitRef.current, owner)) return () => {};

    let request = readRequest.current;
    if (!request || request.reader !== expectedReader || request.version !== version) {
      const promise = Promise.resolve().then(() => {
        if (!canDispatchCurationRead(waitRef.current, owner)) return;
        return admission.canRead(expectedReader, version)
          ? invocationTransport.read(expectedReader)
          : ({ ok: false, reason: 'unavailable' } as const);
      });
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
        if (!live || result === undefined || !admission.canRead(expectedReader, version)) return;
        if (result.ok) {
          retireCurationReadWait(waitRef.current);
          replaceWait(null);
          if (result.reader !== expectedReader) {
            const refusal = { ok: false as const, reason: 'forbidden' as const, admissionChanged: true };
            setFreshResult((previous) =>
              admission.canRead(expectedReader, version)
                ? { reader: expectedReader, version, result: refusal }
                : previous,
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
        replaceWait(waitAfterCurationRead(waitRef.current, owner, result));
        setFreshResult((previous) =>
          admission.canRead(expectedReader, version) ? { reader: expectedReader, version, result } : previous,
        );
      },
      () => {
        if (!live || !admission.canRead(expectedReader, version)) return;
        const unavailable = { ok: false as const, reason: 'unavailable' as const };
        replaceWait(waitAfterCurationRead(waitRef.current, owner, unavailable));
        setFreshResult((previous) =>
          admission.canRead(expectedReader, version)
            ? { reader: expectedReader, version, result: unavailable }
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

  const currentFreshAdmission = lease?.kind === 'fresh' && freshResult?.lease === lease ? freshResult.result : null;
  const currentAdmission = initialAdmission ?? currentFreshAdmission;

  if (snapshot.session.state === 'signed-out') return failureView({ ok: false, reason: 'signed-out' }, locale);
  if (snapshot.session.state === 'unavailable') return failureView({ ok: false, reason: 'unavailable' }, locale);
  if (snapshot.session.state === 'signed-in' && !reader) return failureView({ ok: false, reason: 'forbidden' }, locale);
  if (!reader && snapshot.session.state === 'unknown')
    return initial.ok && lease?.kind === 'initial'
      ? failureView({ ok: false, reason: 'unavailable' }, locale)
      : !initial.ok
        ? failureView(initial, locale)
        : failureView({ ok: false, reason: 'unavailable' }, locale);

  if (!currentAdmission) {
    const failedRead =
      needsRead &&
      freshResult?.reader === reader &&
      freshResult.version === snapshot.version &&
      !freshResult.lease &&
      !freshResult.result.ok
        ? freshResult.result
        : null;
    if (failedRead) return retryableReadFailure(failedRead, locale, { waiting, onRetry: retryAdmission });
    if (!needsRead)
      return !initial.ok ? failureView(initial, locale) : failureView({ ok: false, reason: 'unavailable' }, locale);
    return <p role="status">{m.curation_loading({}, options)}</p>;
  }
  if (!currentAdmission.ok)
    return retryableReadFailure(currentAdmission, locale, needsRead ? { waiting, onRetry: retryAdmission } : undefined);
  if (currentAdmission.reader !== reader) return failureView({ ok: false, reason: 'forbidden' }, locale);
  if (!lease) return failureView({ ok: false, reason: 'unavailable' }, locale);

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
  const options = presentationMessageOptions(locale);
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
  const waitOwner = reader ? { reader, generation: lifecycle.epoch } : null;
  const { waitRef, waiting, replaceWait } = useCurationReadWait(waitOwner);
  const initialAdmission = lifecycle.epoch === 0 && initial.ok && reader === initial.reader;
  const needsRead = lifecycle.epoch > 0 && reader !== null;
  const currentAdmission = initialAdmission
    ? initial
    : admission?.epoch === lifecycle.epoch && admission.reader === reader
      ? admission.result
      : null;

  function applyAdmission(epoch: number, expectedReader: string, result: CurationRead) {
    if (lifecycleRef.current.epoch !== epoch || lifecycleRef.current.reader !== expectedReader) return;
    const owner = { reader: expectedReader, generation: epoch };
    if (result.ok) {
      retireCurationReadWait(waitRef.current);
      replaceWait(null);
    } else replaceWait(waitAfterCurationRead(waitRef.current, owner, result));
    setAdmission({ epoch, reader: expectedReader, result });
  }

  function readAdmission(expectedReader: string, epoch: number, invocationTransport: CurationEditorTransport) {
    const owner = { reader: expectedReader, generation: epoch };
    if (!canDispatchCurationRead(waitRef.current, owner)) return 0;
    const serial = ++admissionRequest.current;
    void invocationTransport
      .read(expectedReader)
      .then((result) => {
        if (admissionRequest.current === serial) applyAdmission(epoch, expectedReader, result);
      })
      .catch(() => {
        if (admissionRequest.current === serial)
          applyAdmission(epoch, expectedReader, { ok: false, reason: 'unavailable' });
      });
    return serial;
  }

  useEffect(() => {
    if (!needsRead || !reader) return;
    const epoch = lifecycle.epoch;
    const serial = readAdmission(reader, epoch, transport);
    return () => {
      if (serial && admissionRequest.current === serial) admissionRequest.current += 1;
    };
  }, [lifecycle.epoch, needsRead, reader]);

  function retryAdmission() {
    if (!needsRead || !reader) return;
    readAdmission(reader, lifecycle.epoch, transport);
  }

  if (observedSession.state === 'signed-out') return failureView({ ok: false, reason: 'signed-out' }, locale);
  if (observedSession.state === 'unavailable') return failureView({ ok: false, reason: 'unavailable' }, locale);
  if (observedSession.state === 'signed-in' && !reader) return failureView({ ok: false, reason: 'forbidden' }, locale);
  if (!reader && observedSession.state === 'unknown')
    return !initial.ok ? failureView(initial, locale) : failureView({ ok: false, reason: 'forbidden' }, locale);
  if (!currentAdmission) {
    if (!needsRead)
      return !initial.ok ? failureView(initial, locale) : failureView({ ok: false, reason: 'unavailable' }, locale);
    return <p role="status">{m.curation_loading({}, options)}</p>;
  }
  if (!currentAdmission.ok)
    return retryableReadFailure(currentAdmission, locale, needsRead ? { waiting, onRetry: retryAdmission } : undefined);
  if (currentAdmission.reader !== reader) return failureView({ ok: false, reason: 'forbidden' }, locale);

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
  const formId = useId();
  const [current, setCurrent] = useState<CurationRead>(initial);
  const [draft, setDraft] = useState(() => (initial.ok ? presentationDraft(initial) : null));
  const waitOwner = { reader, generation: epoch };
  const { waitRef, waiting, replaceWait } = useCurationReadWait(waitOwner);
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
  const [removeConfirm, setRemoveConfirm] = useState<KeyedTemplateRemoval | null>(null);
  const [generation, setGeneration] = useState(0);
  const [scope, setScope] = useState<'base' | 'type' | 'route'>('type');
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
  const options = presentationMessageOptions(locale);
  const navigationGuard = (
    <CurationNavigationGuard
      dirty={dirty}
      retainedPublication={pendingPublication}
      fallbackFocus={pageRegion}
      locale={locale}
    />
  );
  const viewNames = presentationViewNames(locale);
  const scopeNames = {
    generic: m.curation_generic({}, options),
    base: m.curation_base({}, options),
    type: m.curation_type({}, options),
    route: m.curation_route({}, options),
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
  const laterChanges = !!draft && !!publicationState.intent && hasDraftChanges(draft, publicationState.intent.profile);
  const unresolvedPublication = pendingPublication && !invalidPublication;

  if (admissionFailure)
    return (
      <>
        <CurationNavigationGuard
          dirty={false}
          retainedPublication={pendingPublication}
          fallbackFocus={pageRegion}
          locale={locale}
        />
        <CurationFailureNotice failure={admissionFailure} locale={locale} />
      </>
    );

  function validationCorrection(source: typeof failureProfile) {
    return {
      describe(pointer: string) {
        const target = source && resolveCorrection(source, pointer, localeRef.current);
        return target
          ? m.curation_correction_target(
              {
                template: templateLabel(target.template),
                view: viewNames[target.view],
                component: target.component?.type ?? m.curation_page_settings({}, options),
                field: target.label,
              },
              options,
            )
          : m.curation_correction_unknown({}, options);
      },
      correct(pointer: string) {
        if (!isCurrent() || !draft || busy) return;
        const original = source && resolveCorrection(source, pointer, localeRef.current);
        const target = original && currentCorrection(draft.profile, original);
        setOwned(setEditorOpen, true);
        setOwned(setCorrection, target ? { ...target } : null);
        setOwned(
          setMessage,
          target
            ? source && JSON.stringify(source) !== JSON.stringify(draft.profile)
              ? m.curation_correction_later({}, options)
              : m.curation_correction_help({}, options)
            : original
              ? m.curation_correction_missing({}, options)
              : m.curation_correction_unknown({}, options),
        );
        if (target)
          setOwned(
            setDraft,
            (value) => value && { ...value, selection: { template: target.template, view: target.view } },
          );
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
    if (!canDispatchCurationRead(waitRef.current, waitOwner)) return;
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
        retireCurationReadWait(waitRef.current);
        replaceWait(null);
        if (next.reader !== reader) {
          setOwned(setCurrent, { ok: false, reason: 'forbidden' });
          setOwned(setDraft, null);
          return;
        }
        setOwned(setCurrent, next);
        setOwned(setDraft, presentationDraft(next));
        setOwned(setGeneration, (value) => value + 1);
        setOwned(setMessage, m.curation_reloaded({}, options));
      } else if (next.reason === 'signed-out') {
        retireCurationReadWait(waitRef.current);
        replaceWait(null);
        setOwned(setCurrent, next);
        setOwned(setDraft, null);
      } else {
        replaceWait(waitAfterCurationRead(waitRef.current, waitOwner, next));
        setOwned(setFailure, next);
      }
    } catch {
      if (!isCurrent()) return;
      const unavailable = { ok: false as const, reason: 'unavailable' as const };
      replaceWait(waitAfterCurationRead(waitRef.current, waitOwner, unavailable));
      setOwned(setFailure, unavailable);
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

  function addCompanion(view: View, source: CompanionViewSource) {
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy) return;
    const template = draft.selection.template;
    setOwned(setDraft, (value) => {
      if (!value) return value;
      const editors = { ...value.editors };
      delete editors[selectionKey({ template, view })];
      return {
        ...value,
        profile: addCompanionView(value.profile, template, view, source),
        selection: { template, view },
        editors,
      };
    });
    setOwned(setCorrection, null);
    setOwned(setFailure, null);
    setOwned(setFailureProfile, null);
    setOwned(setMessage, '');
    setOwned(setEditorOpen, true);
  }

  function resetCompanion(view: View) {
    if (
      !isCurrent() ||
      !draft ||
      inFlight.current ||
      publication.getSnapshot().busy ||
      draft.selection.view !== view ||
      viewOf(draft.profile, draft.selection.template, view) === undefined
    )
      return;
    const template = draft.selection.template;
    setOwned(setDraft, (value) => {
      if (!value) return value;
      const editors = { ...value.editors };
      delete editors[selectionKey({ template, view })];
      return {
        ...value,
        profile: resetCompanionView(value.profile, template, view),
        selection: { template, view: 'overview' as const },
        editors,
      };
    });
    setOwned(setCorrection, null);
    setOwned(setFailure, null);
    setOwned(setFailureProfile, null);
    setOwned(setMessage, '');
    setOwned(setEditorOpen, true);
  }

  function addTemplate(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || !draft || inFlight.current || publication.getSnapshot().busy) return;
    const template: Template = { scope, key };
    let profile = draft.profile;
    if (scope === 'base') {
      const addition = addStructuralBaseTemplate(profile, key);
      if (!addition.ok) {
        setOwned(setFailure, { ok: false, reason: 'invalid', errors: addition.errors });
        if (addition.profile) setOwned(setFailureProfile, addition.profile);
        return;
      }
      profile = addition.profile;
    } else {
      if (profileTemplates(profile).some((item) => item.scope === scope && item.key === key)) {
        setOwned(setFailure, {
          ok: false,
          reason: 'invalid',
          errors: [{ pointer: `/${scope === 'type' ? 'types' : 'routes'}`, code: 'duplicate' }],
        });
        return;
      }
      profile = withTemplate(profile, template, structuredClone(overviewOf(profile, { scope: 'generic', key: null })!));
      const errors = validateProfile(platformRegistry, profile);
      if (errors.length) {
        setOwned(setFailure, { ok: false, reason: 'invalid', errors });
        setOwned(setFailureProfile, profile);
        return;
      }
    }
    setOwned(setDraft, { ...draft, profile, selection: { template, view: 'overview' } });
    setOwned(setEditorOpen, true);
    setOwned(setKey, '');
    setOwned(setFailure, null);
    setOwned(setMessage, m.curation_added({}, options));
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
    const profile = draftPublicationProfile(draft, edited);
    if (!profile) return;
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

  const activeRemoval =
    removeConfirm && isCurrent() && draft && keyedTemplateRemovalApplies(draft, removeConfirm) ? removeConfirm : null;
  if (removeConfirm !== null && activeRemoval === null) setRemoveConfirm(null);

  if (!draft)
    return (
      <div className="space-y-4">
        {navigationGuard}
        <CurationFailureNotice
          failure={failure ?? (current.ok ? { ok: false, reason: 'unavailable' } : current)}
          locale={locale}
        />
        <Button className={editorControlClass} disabled={busy || waiting} onClick={() => void reload()}>
          {m.curation_reload({}, options)}
        </Button>
      </div>
    );

  const { profile, selection, editors, saved } = draft;
  const templates = profileTemplates(profile);
  const removableTemplate: KeyedTemplate | null = selection.template.scope === 'generic' ? null : selection.template;
  const views = templateViewNames(profile, selection.template);
  const document = viewOf(profile, selection.template, selection.view)!;
  const editorKey = selectionKey(selection);
  const loading = (
    <p className="p-4" role="status">
      {m.curation_loading({}, options)}
    </p>
  );

  return (
    <article
      ref={pageRegion}
      tabIndex={-1}
      className="min-w-0 space-y-6 rounded-md font-sans text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-busy={busy}
    >
      {navigationGuard}
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{m.curation_heading({}, options)}</h1>
        <p className="text-muted-foreground">{m.presentation_editor_draft_summary({}, options)}</p>
        <p className="text-sm text-muted-foreground">{m.curation_instructions({}, options)}</p>
        <p role="status" className="text-sm">
          {invalidPublication && pendingPublication
            ? laterChanges && dirty
              ? m.curation_invalid_later({}, options)
              : m.curation_invalid_retained({}, options)
            : dirty
              ? m.curation_unsaved({}, options)
              : m.curation_saved({}, options)}
        </p>
        <details className="text-sm">
          <summary className={editorDisclosureClass}>
            {m.presentation_editor_saved_version_details({}, options)}
          </summary>
          <p className="mt-2 break-all font-mono">
            {m.presentation_editor_version_reference({ head: saved.head, digest: saved.digest }, options)}
          </p>
        </details>
      </header>
      {message && (
        <p role="status" className="rounded-lg border border-border bg-card p-4">
          {message}
        </p>
      )}
      {failure && (
        <div className={editorRecoveryClass}>
          <CurationFailureNotice failure={failure} correction={validationCorrection(failureProfile)} locale={locale} />
        </div>
      )}
      {preview}
      <div className={editorRecoveryClass}>
        <CurationPublicationRecovery
          publication={publication}
          {...(visit ? { visit } : {})}
          profile={profile}
          head={saved.head}
          locale={locale}
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
            setOwned(
              setMessage,
              choice === 'keep' ? m.curation_reconciled({}, options) : m.curation_discarded({}, options),
            );
          }}
        />
      </div>
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="flex flex-wrap gap-3">
          {!editorOpen && (
            <Button
              className={editorControlClass}
              disabled={!dirty || unresolvedPublication || (invalidPublication && !laterChanges)}
              onClick={() => void publish()}
            >
              {m.curation_publish({}, options)}
            </Button>
          )}
          <Button
            className={editorControlClass}
            variant="outline"
            disabled={!dirty}
            onClick={() => isCurrent() && setOwned(setConfirm, 'discard')}
          >
            {m.curation_view_discard({}, options)}
          </Button>
          <Button
            className={editorControlClass}
            variant="outline"
            disabled={waiting && !pendingPublication}
            onClick={() =>
              isCurrent() && (!pendingPublication && dirty ? setOwned(setConfirm, 'reload') : void reload())
            }
          >
            {m.curation_reload({}, options)}
          </Button>
        </div>
        <section
          className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
          aria-label={m.curation_templates({}, options)}
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${formId}-template`}>{m.curation_template({}, options)}</FieldLabel>
              <NativeSelect
                id={`${formId}-template`}
                className="w-full min-w-0 max-w-full"
                aria-describedby={selection.template.key !== null ? `${formId}-template-value` : undefined}
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
              {selection.template.key !== null && (
                <p
                  id={`${formId}-template-value`}
                  className="text-sm text-muted-foreground select-text [overflow-wrap:anywhere]"
                >
                  {templateLabel(selection.template)}
                </p>
              )}
              {removableTemplate && (
                <Button
                  className={editorControlClass}
                  variant="outline"
                  onClick={() => {
                    if (!isCurrent() || !visit || !removableTemplate) return;
                    const intention = reviewKeyedTemplateRemoval(draft, removableTemplate, visit);
                    if (intention) setOwned(setRemoveConfirm, intention);
                  }}
                >
                  {m.curation_remove({}, options)}
                </Button>
              )}
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${formId}-view`}>{m.curation_view({}, options)}</FieldLabel>
              <NativeSelect
                id={`${formId}-view`}
                className="w-full min-w-0 max-w-full"
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
          <CurationCompanionViews
            key={JSON.stringify(selection.template)}
            profile={profile}
            selection={selection}
            viewNames={viewNames}
            disabled={busy}
            onAdd={addCompanion}
            onReset={resetCompanion}
          />
          <details className="text-sm">
            <summary className={editorDisclosureClass}>{m.presentation_editor_resolver_details({}, options)}</summary>
            <p className="mt-2 text-muted-foreground">{m.curation_fallback({}, options)}</p>
          </details>
        </section>
        {editorOpen ? (
          <section
            ref={editorRegion}
            tabIndex={-1}
            className="min-w-0 space-y-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={m.curation_editor({}, options)}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                {templateLabel(selection.template)} · {viewNames[selection.view]}
              </h2>
              <Button
                className={editorControlClass}
                variant="outline"
                onClick={() => isCurrent() && setOwned(setEditorOpen, false)}
              >
                {m.curation_close({}, options)}
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
                    publishDisabled={!dirty || unresolvedPublication || busy || (invalidPublication && !laterChanges)}
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
          <Button
            className={editorControlClass}
            variant="outline"
            onClick={() => isCurrent() && setOwned(setEditorOpen, true)}
          >
            {selection.template.scope}: {selection.template.key ?? m.curation_generic({}, options)}
          </Button>
        )}
        <form className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4" onSubmit={addTemplate}>
          <h2 className="font-semibold">{m.curation_add({}, options)}</h2>
          <p id={`${formId}-add-hint`} className="text-sm text-muted-foreground">
            {m.curation_add_hint({}, options)}
          </p>
          <div className="grid min-w-0 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${formId}-scope`}>{m.curation_scope({}, options)}</FieldLabel>
              <NativeSelect
                id={`${formId}-scope`}
                className="w-full min-w-0 max-w-full"
                value={scope}
                onChange={(event) => isCurrent() && setOwned(setScope, event.target.value as 'base' | 'type' | 'route')}
              >
                <NativeSelectOption value="base">{scopeNames.base}</NativeSelectOption>
                <NativeSelectOption value="type">{scopeNames.type}</NativeSelectOption>
                <NativeSelectOption value="route">{scopeNames.route}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${formId}-key`}>{m.curation_key({}, options)}</FieldLabel>
              <Input
                id={`${formId}-key`}
                aria-describedby={key ? `${formId}-add-hint ${formId}-key-value` : `${formId}-add-hint`}
                value={key}
                onChange={(event) => isCurrent() && setOwned(setKey, event.target.value)}
                required
                autoComplete="off"
              />
              {key && (
                <p id={`${formId}-key-value`} className="text-sm select-text [overflow-wrap:anywhere]">
                  {key}
                </p>
              )}
            </Field>
            <Button className={`${editorControlClass} w-full sm:mt-7 sm:w-auto`} type="submit" variant="outline">
              {m.curation_add({}, options)}
            </Button>
          </div>
        </form>
      </fieldset>
      <AlertDialog
        open={activeRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveConfirm(null);
        }}
      >
        {activeRemoval && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {m.curation_remove_title({ template: templateLabel(activeRemoval.template) }, options)}
              </AlertDialogTitle>
              <AlertDialogDescription>{m.curation_remove_warning({}, options)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className={editorControlClass}>{m.action_cancel({}, options)}</AlertDialogCancel>
              <AlertDialogAction
                className={editorControlClass}
                onClick={() => {
                  const intention = activeRemoval;
                  if (isCurrent() && intention) {
                    setOwned(setDraft, (value) => value && confirmKeyedTemplateRemoval(value, intention));
                    setOwned(setCorrection, null);
                    setOwned(setFailure, null);
                  }
                  setRemoveConfirm(null);
                }}
              >
                {m.curation_remove({}, options)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && isCurrent()) setOwned(setConfirm, null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.curation_discard_title({}, options)}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'reload' ? m.curation_reload_warning({}, options) : m.curation_discard_warning({}, options)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={editorControlClass}>{m.curation_keep({}, options)}</AlertDialogCancel>
            <AlertDialogAction
              className={editorControlClass}
              onClick={() => {
                if (!isCurrent()) return;
                if (confirm === 'reload') void reload();
                else {
                  setOwned(setDraft, (value) => value && discardPresentationDraft(value));
                  setOwned(setGeneration, (value) => value + 1);
                  setOwned(setCorrection, null);
                  setOwned(setFailure, null);
                  setOwned(setMessage, m.curation_view_discarded({}, options));
                }
                setOwned(setConfirm, null);
              }}
            >
              {confirm === 'reload' ? m.curation_discard_reload({}, options) : m.curation_view_discard({}, options)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
