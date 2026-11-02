import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { SubjectTermsNavigationGuard } from './subject-terms-navigation';
import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { termsFieldGuidance } from './subject-terms-guidance';
import {
  hasTermsPatch,
  hasEffectiveTermsPatch,
  languageDraft,
  termFields,
  termsPatch,
  type LanguageDraft,
  type TermField,
  type TermsCommand,
  type TermsDraft,
  type TermsFailure,
  type TermsRead,
  type TermsResult,
  type TermsSnapshot,
  type TermsTransport,
} from './subject-terms';

// Keep dense fine-pointer controls while allowing translated actions to grow onto multiple lines.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-h-11 md:pointer-fine:min-h-8';
// Leave room for the shared frame's focus/hover surface within the phone column.
const frameClassName = 'm-1 flex min-w-0 flex-col gap-4 p-3 sm:p-4';
// NativeSelect applies className to its wrapper; enlarge the actual select inside it.
const selectClassName = 'min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11 md:pointer-fine:[&_select]:min-h-8';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm underline [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';

export const SubjectTermsPage = catalogueEditor(SubjectTermsPageLive);

type LocalTermsDecision = {
  language: string;
  remove: boolean;
  generation: number;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: TermsTransport;
  snapshot: TermsSnapshot;
  draft: LanguageDraft | undefined;
  opener: HTMLButtonElement;
};

type TermsReadVisit = {
  id: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: TermsTransport;
  generation: number;
};

type InitialTermsRetryFocus = {
  action: object;
  visit: TermsReadVisit;
  opener: HTMLButtonElement;
  cancelled: boolean;
};

function needsLocalTermsConfirmation(snapshot: TermsSnapshot, language: string, draft?: LanguageDraft) {
  if (!draft) return false;
  const original = languageDraft(snapshot.subject, language);
  return termFields.some((field) => {
    const edit = draft[field];
    if (edit.mode === 'remove') return true;
    if (edit.mode !== 'set' || edit.value === original[field].value) return false;
    return edit.value !== '' || Object.hasOwn(snapshot.subject[field], language);
  });
}

function SubjectTermsPageLive({
  id,
  locale,
  session,
  transport,
  typeLabels,
}: {
  id: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: TermsTransport;
  typeLabels?: Record<string, string>;
}) {
  const formId = useId();
  const domId = (part: string) => `${formId}-${part}`;
  const lifetime = useEditorLifetime();
  const options = { locale: locale as never };
  const retryAction = useRef<object | null>(null);
  const retryFocus = useRef<InitialTermsRetryFocus | null>(null);
  const retryBoundary = useRef<HTMLElement | null>(null);
  const currentOrigin = useRef<object | null>(null);
  const [initialRetry, setInitialRetry] = useState<'pending' | 'settled'>();
  const [settledRetry, setSettledRetry] = useState<InitialTermsRetryFocus | null>(null);
  const currentVisit = useRef<TermsReadVisit | null>(null);
  const previousVisit = currentVisit.current;
  if (
    !previousVisit ||
    previousVisit.id !== id ||
    previousVisit.locale !== locale ||
    previousVisit.session !== session ||
    previousVisit.transport !== transport ||
    previousVisit.generation !== lifetime.generation
  ) {
    if (retryFocus.current) retryFocus.current.cancelled = true;
    retryAction.current = null;
    currentVisit.current = {
      id,
      locale,
      session,
      transport,
      generation: lifetime.generation,
    };
  }
  const visit = currentVisit.current!;
  const query = useQuery({
    queryKey: [...['catalogue-terms', id, locale], lifetime.generation],
    queryFn: () => transport.read(id),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [language, setLanguage] = useState(locale);
  const [newLanguage, setNewLanguage] = useState('');
  const [languageError, setLanguageError] = useState(false);
  const [addedLanguages, setAddedLanguages] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<TermsDraft>({});
  const [failure, setFailure] = useState<TermsFailure>();
  const [comparison, setComparison] = useState<TermsRead>();
  const [saved, setSaved] = useState<Extract<TermsResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localDecision, setLocalDecision] = useState<LocalTermsDecision | null>(null);
  const running = useRef(false);
  const pending = useRef<TermsCommand | null>(null);
  const localDecisionRef = useRef<LocalTermsDecision | null>(null);
  const decisionFocus = useRef<{ decision: LocalTermsDecision; target: HTMLElement; language?: string } | null>(null);
  const focusAfterScaffoldRemoval = useRef(false);
  const cancelDecision = useRef<HTMLButtonElement>(null);
  const languageRef = useRef(language);
  languageRef.current = language;
  const controls = useRef<Record<string, { focus: () => void } | null>>({});
  const [correction, setCorrection] = useState<{
    failure: TermsFailure;
    drafts: TermsDraft;
    tag: string;
    control: string;
  }>();
  const base =
    saved?.reader.state === 'ready'
      ? saved.reader.snapshot
      : query.data?.state === 'ready'
        ? query.data.snapshot
        : undefined;
  const origin = useMemo(
    () => ({}),
    [query.data, query.error, query.dataUpdatedAt, query.errorUpdatedAt, initialRetry, visit],
  );
  currentOrigin.current =
    !base && !query.isPending && !query.isFetching && !retryAction.current ? origin : null;
  useEffect(() => {
    const cancelOnPointer = () => {
      if (retryFocus.current) retryFocus.current.cancelled = true;
    };
    const cancelOnFocus = (event: FocusEvent) => {
      const intent = retryFocus.current;
      if (intent && event.target !== intent.opener && event.target !== document.body)
        intent.cancelled = true;
    };
    document.addEventListener('pointerdown', cancelOnPointer, true);
    document.addEventListener('focusin', cancelOnFocus, true);
    return () => {
      document.removeEventListener('pointerdown', cancelOnPointer, true);
      document.removeEventListener('focusin', cancelOnFocus, true);
    };
  }, []);
  useLayoutEffect(() => {
    retryAction.current = null;
    if (retryFocus.current) retryFocus.current.cancelled = true;
    retryFocus.current = null;
    setSettledRetry(null);
    setInitialRetry(undefined);
    return () => {
      retryAction.current = null;
      if (retryFocus.current) retryFocus.current.cancelled = true;
      retryFocus.current = null;
    };
  }, [visit]);
  async function retryInitial(event: MouseEvent<HTMLButtonElement>) {
    if (
      !lifetime.active() ||
      currentOrigin.current !== origin ||
      retryAction.current ||
      query.isFetching ||
      currentVisit.current !== visit
    )
      return;
    const action = {};
    retryAction.current = action;
    currentOrigin.current = null;
    const intent =
      event.detail === 0
        ? { action, visit, opener: event.currentTarget, cancelled: false }
        : null;
    retryFocus.current = intent;
    setSettledRetry(null);
    setInitialRetry('pending');
    try {
      await query.refetch({ cancelRefetch: false });
    } finally {
      if (retryAction.current !== action) return;
      retryAction.current = null;
      if (!lifetime.active() || currentVisit.current !== visit) return;
      setInitialRetry('settled');
      if (intent && retryFocus.current === intent) setSettledRetry(intent);
    }
  }
  // Deliberate keyboard recovery returns to the current editor or truthful failure boundary.
  useLayoutEffect(() => {
    if (!settledRetry || query.isPending || query.isFetching) return;
    setSettledRetry(null);
    setInitialRetry(undefined);
    if (retryFocus.current === settledRetry) retryFocus.current = null;
    if (
      settledRetry.cancelled ||
      !lifetime.active() ||
      currentVisit.current !== settledRetry.visit
    )
      return;
    const active = document.activeElement;
    if (settledRetry.opener.isConnected && active === settledRetry.opener) return;
    if (active !== document.body && active !== settledRetry.opener) return;
    (base ? document.getElementById(domId('title')) : retryBoundary.current)?.focus();
  }, [base, lifetime, query.isFetching, query.isPending, settledRetry, visit]);
  const current = useRef({
    language,
    locale,
    session,
    transport,
    snapshot: base,
    drafts,
    addedLanguages,
    generation: lifetime.generation,
    active: lifetime.active,
    available: false,
  });
  current.current = {
    language,
    locale,
    session,
    transport,
    snapshot: base,
    drafts,
    addedLanguages,
    generation: lifetime.generation,
    active: lifetime.active,
    available:
      !busy &&
      !saved &&
      session === 'signed-in' &&
      failure?.reason !== 'stale' &&
      failure?.reason !== 'conflict' &&
      !(failure?.reason === 'unavailable' && pending.current),
  };
  const uncertain = failure?.reason === 'unavailable' && pending.current !== null;
  const stale = failure?.reason === 'stale' || failure?.reason === 'conflict';
  const isCurrentDecision = (decision: LocalTermsDecision) => {
    const latest = current.current;
    return (
      localDecisionRef.current === decision &&
      latest.active() &&
      latest.available &&
      languageRef.current === decision.language &&
      latest.language === decision.language &&
      latest.locale === decision.locale &&
      latest.session === decision.session &&
      latest.transport === decision.transport &&
      latest.snapshot === decision.snapshot &&
      latest.generation === decision.generation &&
      latest.drafts[decision.language] === decision.draft &&
      (!decision.remove || latest.addedLanguages.includes(decision.language))
    );
  };
  const activeDecision = localDecision && isCurrentDecision(localDecision) ? localDecision : null;
  const locked = busy || uncertain || stale || !!saved || session !== 'signed-in' || !!activeDecision;

  function chooseLanguage(next: string) {
    languageRef.current = next;
    setLanguage(next);
  }

  function clearLocalDraft(
    target: string,
    remove: boolean,
    expected: LanguageDraft | undefined,
    focusScaffold = false,
  ) {
    if (
      !lifetime.active() ||
      !base ||
      busy ||
      uncertain ||
      stale ||
      saved ||
      session !== 'signed-in' ||
      running.current
    )
      return;
    if (drafts[target] !== expected) return;
    // Stored terms can only be removed through an explicit field change and submission.
    if (remove && termFields.some((field) => Object.hasOwn(base.subject[field], target))) return;
    setDrafts((previous) => {
      if (previous[target] !== expected) return previous;
      const next = { ...previous };
      delete next[target];
      return next;
    });
    setFailure(undefined);
    if (remove) {
      setAddedLanguages((previous) => previous.filter((tag) => tag !== target));
      chooseLanguage(locale);
      if (focusScaffold) focusAfterScaffoldRemoval.current = true;
    }
  }

  function restoreDecisionFocus() {
    const intent = decisionFocus.current;
    decisionFocus.current = null;
    if (!intent) return false;
    const latest = current.current;
    return latest.active() &&
      latest.generation === intent.decision.generation &&
      latest.locale === intent.decision.locale &&
      latest.session === intent.decision.session &&
      latest.transport === intent.decision.transport &&
      latest.snapshot === intent.decision.snapshot &&
      (intent.language === undefined || latest.language === intent.language) &&
      intent.target.isConnected
      ? intent.target
      : false;
  }

  function closeLocalDecision() {
    const decision = localDecisionRef.current;
    if (!decision) return;
    if (decision && isCurrentDecision(decision)) {
      decisionFocus.current = { decision, target: decision.opener, language: decision.language };
    } else {
      decisionFocus.current = null;
    }
    localDecisionRef.current = null;
    setLocalDecision(null);
  }

  function requestLocalAction(remove: boolean, opener: HTMLButtonElement) {
    if (!lifetime.active() || !base || locked || running.current) return;
    if (remove && termFields.some((field) => Object.hasOwn(base.subject[field], language))) return;
    const draft = drafts[language];
    if (!needsLocalTermsConfirmation(base, language, draft)) {
      clearLocalDraft(language, remove, draft, remove);
      return;
    }
    const decision: LocalTermsDecision = {
      language,
      remove,
      generation: lifetime.generation,
      locale,
      session,
      transport,
      snapshot: base,
      draft,
      opener,
    };
    decisionFocus.current = null;
    localDecisionRef.current = decision;
    setLocalDecision(decision);
  }

  function confirmLocalAction(decision: LocalTermsDecision) {
    if (!isCurrentDecision(decision)) return;
    const target = decision.remove
      ? document.getElementById(domId('language'))
      : document.getElementById(domId('language'));
    if (target instanceof HTMLElement) decisionFocus.current = { decision, target };
    localDecisionRef.current = null;
    clearLocalDraft(decision.language, decision.remove, decision.draft);
    setLocalDecision(null);
  }

  useEffect(() => {
    if (localDecision && !isCurrentDecision(localDecision)) {
      if (localDecisionRef.current === localDecision) localDecisionRef.current = null;
      decisionFocus.current = null;
      setLocalDecision(null);
    }
  }, [localDecision, language, locale, session, transport, base, drafts, addedLanguages, lifetime.generation]);

  useLayoutEffect(() => {
    if (focusAfterScaffoldRemoval.current) {
      focusAfterScaffoldRemoval.current = false;
      document.getElementById(domId('language'))?.focus();
    }
  }, [language, addedLanguages]);
  // Old rendered correction actions must never address a replacement draft or reading.
  const currentCorrection = useRef({ failure, drafts, locked });
  currentCorrection.current = { failure, drafts, locked };
  useLayoutEffect(() => {
    if (!correction) return;
    setCorrection(undefined);
    if (
      !lifetime.active() ||
      locked ||
      correction.failure !== failure ||
      correction.drafts !== drafts ||
      correction.tag !== language
    )
      return;
    controls.current[correction.control]?.focus();
  }, [correction, failure, drafts, language, locked, lifetime]);
  const fieldLabel = (field: TermField) =>
    field === 'labels'
      ? m.catalogue_create_label({}, options)
      : field === 'descriptions'
        ? m.catalogue_create_description({}, options)
        : m.catalogue_create_aliases({}, options);
  const failureText = (reason: TermsFailure['reason']) =>
    reason === 'stale'
      ? m.catalogue_terms_stale({}, options)
      : reason === 'conflict'
        ? m.catalogue_terms_conflict({}, options)
        : reason === 'denied'
          ? m.catalogue_terms_denied({}, options)
          : reason === 'concealed'
            ? m.catalogue_create_concealed({}, options)
            : reason === 'signed-out'
              ? m.catalogue_create_signed_out({}, options)
              : reason === 'invalid'
                ? m.catalogue_create_invalid({}, options)
                : m.catalogue_terms_uncertain({}, options);

  function update(field: TermField, edit: Partial<LanguageDraft[TermField]>) {
    if (!lifetime.active()) return;
    if (!base || locked) return;
    setDrafts((previous) => {
      const current = previous[language] ?? languageDraft(base.subject, language);
      return { ...previous, [language]: { ...current, [field]: { ...current[field], ...edit } } };
    });
    setFailure(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>, confirmed?: TermsSnapshot) {
    if (!lifetime.active()) return;
    event.preventDefault();
    if (activeDecision) return;
    if (!base || running.current || saved || session !== 'signed-in' || (stale && !confirmed)) return;
    const snapshot = confirmed ?? base;
    if (!pending.current || confirmed) {
      const draft = termsPatch(snapshot.subject, drafts);
      if (draft.errors.length || !hasTermsPatch(draft.patch)) {
        if (confirmed) pending.current = null;
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      pending.current = {
        id: snapshot.subject.id,
        etag: snapshot.etag,
        key: crypto.randomUUID(),
        patch: draft.patch,
        ...(snapshot.session ? { session: snapshot.session } : {}),
      };
    }
    running.current = true;
    setSubmitting(true);
    setBusy(true);
    setComparison(undefined);
    setFailure(undefined);
    try {
      const result = await transport.submit(pending.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        setSaved(result);
        pending.current = null;
      } else {
        setFailure(result);
        if (!['unavailable', 'stale', 'conflict'].includes(result.reason)) pending.current = null;
      }
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setSubmitting(false);
      setBusy(false);
    }
  }

  async function reread() {
    if (!lifetime.active()) return;
    if (!base || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = saved ? await transport.read(saved.id, saved.session) : await transport.read(id, base.session);
      if (!lifetime.active()) return;
      if (saved) setSaved({ ...saved, reader: result });
      else setComparison(result);
    } catch {
      if (!lifetime.active()) return;
      if (saved) setSaved({ ...saved, reader: { state: 'unavailable' } });
      else setComparison({ state: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  function values(snapshot: TermsSnapshot, languages: string[]) {
    return (
      <dl className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]">
        {languages.map((tag) => (
          <div key={tag} className="flex min-w-0 flex-col gap-1">
            <dt className="font-medium">{tag}</dt>
            {termFields.map((field) => (
              <dd key={field} className="text-sm">
                <span className="text-muted-foreground">{fieldLabel(field)}: </span>
                <span lang={tag} className="whitespace-pre-wrap">
                  {Object.hasOwn(snapshot.subject[field], tag)
                    ? termValue(snapshot, field, tag)
                    : m.catalogue_terms_absent({}, options)}
                </span>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    );
  }

  const languages = [
    ...new Set([
      locale,
      language,
      ...addedLanguages,
      ...Object.keys(drafts),
      ...termFields.flatMap((field) => Object.keys(base?.subject[field] ?? {})),
    ]),
  ];
  const row = base ? (drafts[language] ?? languageDraft(base.subject, language)) : undefined;
  const editedLanguages = Object.entries(drafts).flatMap(([tag, draft]) => {
    const fields = termFields.filter((field) => draft[field].mode !== 'keep');
    return fields.length ? [{ tag, fields }] : [];
  });
  const original = base ? languageDraft(base.subject, language) : undefined;
  const canDiscard =
    row &&
    original &&
    termFields.some((field) => row[field].mode !== 'keep' || row[field].value !== original[field].value);
  const dirty = !!base && !saved && hasEffectiveTermsPatch(base.subject, drafts);
  const storedLanguage = !!base && termFields.some((field) => Object.hasOwn(base.subject[field], language));
  const canRemoveLanguage = !storedLanguage && addedLanguages.includes(language);
  const typeLabel = base ? typeLabels?.[base.subject.type] : undefined;
  const errors = failure?.errors ?? [];
  function correctionTarget(pointer: string) {
    // Only exact known field/language pointers can name a control. Array indices must exist.
    const match = /^\/(labels|descriptions|aliases)\/([a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)(?:\/(0|[1-9][0-9]*))?$/.exec(
      pointer,
    );
    if (!match) return;
    const [, fieldName, tag, index] = match;
    const field = fieldName as TermField;
    const draft = drafts[tag!];
    if (
      !draft ||
      (index !== undefined &&
        (field !== 'aliases' ||
          draft.aliases.mode !== 'set' ||
          Number(index) >= draft.aliases.value.split('\n').length))
    )
      return;
    return { tag: tag!, field, control: draft[field].mode === 'set' ? field : `${field}-mode` };
  }
  const fieldErrors = errors.filter(
    (error) => (error.pointer === '/labels' && error.code === 'required') || correctionTarget(error.pointer),
  );
  const guidance = (field: TermField) =>
    row ? termsFieldGuidance(fieldErrors, field, language, row[field], locale) : [];
  const corrections = new Map<string, { tag: string; field: TermField; control: string; messages: string[] }>();
  if (failure?.reason === 'invalid') {
    for (const error of errors) {
      const target = correctionTarget(error.pointer);
      if (!target) continue;
      const { tag, field } = target;
      const key = `${tag}/${field}`;
      const messages = termsFieldGuidance([error], field, tag, drafts[tag]![field], locale);
      const previous = corrections.get(key);
      if (previous) previous.messages = [...new Set([...previous.messages, ...messages])];
      else if (corrections.size < 12)
        corrections.set(key, {
          ...target,
          messages,
        });
    }
  }

  return (
    <article className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-6 text-foreground [overflow-wrap:anywhere]">
      <SubjectTermsNavigationGuard
        active={lifetime.active() && session === 'signed-in'}
        dirty={dirty}
        pending={!!base && !saved && (submitting || uncertain)}
        locale={locale}
      />
      <AlertDialog
        open={!!activeDecision}
        onOpenChange={(open) => {
          if (!open) closeLocalDecision();
        }}
      >
        <AlertDialogContent initialFocus={cancelDecision} finalFocus={restoreDecisionFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.candidate_confirm_title(
                {
                  action: activeDecision?.remove
                    ? m.catalogue_create_remove_language({}, options)
                    : m.catalogue_terms_discard_language({ language: activeDecision?.language ?? language }, options),
                },
                options,
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>{m.catalogue_terms_discard_help({}, options)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelDecision}>{m.candidate_cancel({}, options)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => activeDecision && confirmLocalAction(activeDecision)}
            >
              {activeDecision?.remove
                ? m.catalogue_create_remove_language({}, options)
                : m.catalogue_terms_discard_language({ language: activeDecision?.language ?? language }, options)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className="flex min-w-0 flex-col gap-3">
        <PageHeading id={domId('title')} tabIndex={-1}>
          {m.catalogue_terms_title({}, options)}
        </PageHeading>
        {base && (
          <ContentItemHeading className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">
            {pickText(base.subject.labels, locale).text || m.subject_value_unlabelled({}, options)}
            {typeLabel && <span className="ml-3 text-sm text-muted-foreground">{typeLabel}</span>}
          </ContentItemHeading>
        )}
        <p className="text-muted-foreground">{m.catalogue_terms_intro({}, options)}</p>
        {base && !saved && (
          <a className={linkClassName} href={base.href}>
            {m.catalogue_create_open({}, options)}
          </a>
        )}
      </header>
      {(query.isPending || initialRetry === 'pending') && (
        <p role="status" tabIndex={-1}>
          {m.candidate_loading({}, options)}
        </p>
      )}
      {!base && !query.isPending && (
        <section ref={retryBoundary} role="alert" tabIndex={-1} className="flex min-w-0 flex-col gap-3">
          <p>
            {query.data?.state === 'concealed'
              ? m.catalogue_create_concealed({}, options)
              : query.data?.state === 'denied'
                ? m.catalogue_result_read_denied({}, options)
                : m.catalogue_result_read_unavailable({}, options)}
          </p>
          <Button
            className={actionClassName}
            variant="outline"
            aria-disabled={query.isFetching || retryAction.current !== null}
            onClick={retryInitial}
          >
            {m.catalogue_retry_loading_result({}, options)}
          </Button>
        </section>
      )}
      {base && row && (
        <>
          {session !== 'signed-in' && (
            <p role="status">
              {session === 'signed-out'
                ? m.catalogue_create_signed_out({}, options)
                : session === 'unavailable'
                  ? m.catalogue_create_unavailable({}, options)
                  : m.catalogue_create_loading({}, options)}
              {session === 'signed-out' && (
                <>
                  {' '}
                  <a
                    className={linkClassName}
                    href={`/auth/sign-in?return_to=${encodeURIComponent(`${base.href}/terms`)}`}
                  >
                    {m.account_sign_in({}, options)}
                  </a>
                </>
              )}
            </p>
          )}
          {saved ? (
            <ContentItemFrame as="div" role="status" className={frameClassName}>
              <ContentItemHeading className="font-semibold">{m.catalogue_terms_saved({}, options)}</ContentItemHeading>
              {saved.reader.state === 'ready' ? (
                <>
                  {values(saved.reader.snapshot, termLanguages(saved.reader.snapshot))}
                  <a className={buttonVariants({ className: actionClassName })} href={saved.reader.snapshot.href}>
                    {m.catalogue_create_open({}, options)}
                  </a>
                </>
              ) : (
                <>
                  <p>
                    {saved.reader.state === 'concealed'
                      ? m.catalogue_create_concealed({}, options)
                      : saved.reader.state === 'denied'
                        ? m.catalogue_result_read_denied({}, options)
                        : m.catalogue_terms_reader_unavailable({}, options)}
                  </p>
                  <Button className={actionClassName} disabled={busy} onClick={() => void reread()}>
                    {m.catalogue_retry_loading_result({}, options)}
                  </Button>
                </>
              )}
            </ContentItemFrame>
          ) : (
            <form
              className="flex min-w-0 flex-col gap-6"
              aria-labelledby={domId('title')}
              noValidate
              aria-busy={busy || !!activeDecision}
              onSubmit={(event) => void submit(event, comparison?.state === 'ready' ? comparison.snapshot : undefined)}
            >
              <FieldGroup>
                <Field data-disabled={busy || undefined}>
                  <FieldLabel htmlFor={domId('language')}>{m.catalogue_create_language({}, options)}</FieldLabel>
                  <NativeSelect
                    className={selectClassName}
                    id={domId('language')}
                    aria-describedby={domId('language-help')}
                    value={language}
                    disabled={busy || !!activeDecision}
                    onChange={(event) => chooseLanguage(event.target.value)}
                  >
                    {languages.map((tag) => (
                      <NativeSelectOption key={tag} value={tag}>
                        {tag}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription id={domId('language-help')}>
                    {m.catalogue_create_language_help({}, options)}
                  </FieldDescription>
                </Field>
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
                  <Field
                    className="min-w-0 flex-1"
                    data-invalid={languageError || undefined}
                    data-disabled={locked || undefined}
                  >
                    <FieldLabel htmlFor={domId('new-language')}>
                      {m.catalogue_terms_new_language({}, options)}
                    </FieldLabel>
                    <Input
                      className={inputClassName}
                      id={domId('new-language')}
                      value={newLanguage}
                      disabled={locked}
                      maxLength={64}
                      aria-invalid={languageError}
                      aria-describedby={languageError ? domId('new-language-error') : undefined}
                      onChange={(event) => {
                        setNewLanguage(event.target.value);
                        setLanguageError(false);
                      }}
                    />
                    {languageError && (
                      <FieldError id={domId('new-language-error')}>
                        {m.catalogue_terms_validation_language({}, options)}
                      </FieldError>
                    )}
                  </Field>
                  <Button
                    className={actionClassName}
                    type="button"
                    variant="outline"
                    disabled={locked}
                    onClick={() => {
                      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(newLanguage)) {
                        setLanguageError(true);
                        return;
                      }
                      if (!languages.includes(newLanguage)) {
                        setAddedLanguages((previous) => [...previous, newLanguage]);
                      }
                      chooseLanguage(newLanguage);
                      setNewLanguage('');
                    }}
                  >
                    {m.catalogue_create_add_language({}, options)}
                  </Button>
                </div>
              </FieldGroup>
              {!storedLanguage && <p role="status">{m.catalogue_terms_empty({}, options)}</p>}
              <ContentItemHeading className="font-semibold">{m.creator_editions_draft({}, options)}</ContentItemHeading>
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                  <Button
                    className={actionClassName}
                    type="button"
                    variant="outline"
                    disabled={locked || !canDiscard}
                    aria-describedby={domId('discard-help')}
                    onClick={(event) => requestLocalAction(false, event.currentTarget)}
                  >
                    {m.catalogue_terms_discard_language({ language }, options)}
                  </Button>
                  {canRemoveLanguage && (
                    <Button
                      className={actionClassName}
                      type="button"
                      variant="outline"
                      disabled={locked}
                      aria-describedby={domId('discard-help')}
                      onClick={(event) => requestLocalAction(true, event.currentTarget)}
                    >
                      {m.catalogue_create_remove_language({}, options)}
                    </Button>
                  )}
                </div>
                <p id={domId('discard-help')} className="text-sm text-muted-foreground">
                  {m.catalogue_terms_discard_help({}, options)}
                </p>
              </div>
              <FieldGroup>
                {termFields.map((field) => {
                  const messages = guidance(field);
                  const invalid = messages.length > 0;
                  const errorId = invalid ? domId(`${field}-error`) : undefined;
                  return (
                    <FieldSet key={field} disabled={locked} className="min-w-0 gap-0">
                      <FieldLegend className="px-1">{fieldLabel(field)}</FieldLegend>
                      <ContentItemFrame as="div" className={frameClassName}>
                        <dl className="min-w-0 text-sm">
                          <dt className="text-muted-foreground">{m.catalogue_terms_original({}, options)}</dt>
                          <dd lang={language} className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                            <span lang={language}>
                              {Object.hasOwn(base.subject[field], language)
                                ? termValue(base, field, language)
                                : m.catalogue_terms_absent({}, options)}
                            </span>
                          </dd>
                        </dl>
                        <FieldGroup>
                          <Field data-invalid={invalid || undefined} data-disabled={locked || undefined}>
                            <FieldLabel htmlFor={domId(`${field}-mode`)}>
                              {m.catalogue_terms_action({}, options)}
                            </FieldLabel>
                            <NativeSelect
                              className={`${selectClassName} [&_select:focus]:outline-2 [&_select:focus]:outline-offset-2 [&_select:focus]:outline-ring`}
                              ref={(element) => {
                                controls.current[`${field}-mode`] = element;
                              }}
                              id={domId(`${field}-mode`)}
                              value={row[field].mode}
                              aria-invalid={invalid}
                              aria-describedby={errorId}
                              onChange={(event) =>
                                update(field, { mode: event.target.value as LanguageDraft[TermField]['mode'] })
                              }
                            >
                              <NativeSelectOption value="keep">
                                {m.catalogue_terms_keep({}, options)}
                              </NativeSelectOption>
                              <NativeSelectOption value="set">
                                {m.catalogue_terms_replace({}, options)}
                              </NativeSelectOption>
                              <NativeSelectOption value="remove">
                                {m.catalogue_terms_remove({}, options)}
                              </NativeSelectOption>
                            </NativeSelect>
                          </Field>
                          {row[field].mode === 'set' && (
                            <Field data-invalid={invalid || undefined} data-disabled={locked || undefined}>
                              <FieldLabel htmlFor={domId(field)}>{fieldLabel(field)}</FieldLabel>
                              {field === 'aliases' ? (
                                <Textarea
                                  className="min-w-0 [overflow-wrap:anywhere] focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                                  ref={(element) => {
                                    controls.current[field] = element;
                                  }}
                                  id={domId(field)}
                                  lang={language}
                                  value={row[field].value}
                                  rows={3}
                                  aria-invalid={invalid}
                                  aria-describedby={[domId('aliases-help'), errorId].filter(Boolean).join(' ')}
                                  onChange={(event) => update(field, { value: event.target.value })}
                                />
                              ) : (
                                <Input
                                  className={`${inputClassName} focus:outline-2 focus:outline-offset-2 focus:outline-ring`}
                                  ref={(element) => {
                                    controls.current[field] = element;
                                  }}
                                  id={domId(field)}
                                  lang={language}
                                  value={row[field].value}
                                  maxLength={250}
                                  aria-invalid={invalid}
                                  aria-describedby={errorId}
                                  onChange={(event) => update(field, { value: event.target.value })}
                                />
                              )}
                              {field === 'aliases' && (
                                <FieldDescription id={domId('aliases-help')}>
                                  {m.catalogue_terms_alias_limits({}, options)}
                                </FieldDescription>
                              )}
                            </Field>
                          )}
                          {invalid && <FieldError id={errorId} errors={messages.map((message) => ({ message }))} />}
                        </FieldGroup>
                      </ContentItemFrame>
                    </FieldSet>
                  );
                })}
              </FieldGroup>
              <section aria-labelledby={domId('unsaved')} className="flex min-w-0 flex-col gap-3">
                <ContentItemHeading id={domId('unsaved')} className="font-semibold">
                  {m.catalogue_terms_unsaved_languages({}, options)}
                </ContentItemHeading>
                {editedLanguages.length ? (
                  <ul className="flex min-w-0 flex-col gap-2">
                    {editedLanguages.map(({ tag, fields }) => (
                      <li key={tag}>
                        <Button
                          className={actionClassName}
                          type="button"
                          variant="outline"
                          disabled={busy}
                          aria-pressed={language === tag}
                          onClick={() => setLanguage(tag)}
                        >
                          {tag}: {fields.map(fieldLabel).join(', ')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.catalogue_terms_no_edits({}, options)}</p>
                )}
              </section>
              {failure && (
                <ContentItemFrame as="div" role="alert" className={frameClassName}>
                  <p>{failureText(failure.reason)}</p>
                  {corrections.size > 0 && (
                    <ul className="flex flex-col gap-2">
                      {[...corrections].map(([key, target]) => (
                        <li key={key}>
                          <Button
                            className={actionClassName}
                            type="button"
                            variant="outline"
                            disabled={locked}
                            onClick={() => {
                              const current = currentCorrection.current;
                              if (
                                !lifetime.active() ||
                                current.locked ||
                                current.failure !== failure ||
                                current.drafts !== drafts
                              )
                                return;
                              chooseLanguage(target.tag);
                              setCorrection({ failure, drafts, tag: target.tag, control: target.control });
                            }}
                          >
                            {target.tag}: {fieldLabel(target.field)} — {target.messages.join(' ')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {failure.detail && <p className="text-sm text-muted-foreground">{failure.detail}</p>}
                  {failure.reason === 'denied' && base.profileHref && (
                    <a href={base.profileHref} className={linkClassName}>
                      {m.catalogue_terms_profile({}, options)}
                    </a>
                  )}
                  {stale && (
                    <Button
                      className={actionClassName}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void reread()}
                    >
                      {m.catalogue_terms_compare({}, options)}
                    </Button>
                  )}
                </ContentItemFrame>
              )}
              {comparison && (
                <ContentItemFrame as="div" className={frameClassName} aria-live="polite">
                  <ContentItemHeading className="font-semibold">
                    {m.catalogue_terms_latest({}, options)}
                  </ContentItemHeading>
                  {comparison.state === 'ready' ? (
                    <>
                      {values(comparison.snapshot, [
                        ...new Set([
                          ...languages,
                          ...termFields.flatMap((field) => Object.keys(comparison.snapshot.subject[field])),
                        ]),
                      ])}
                      <p>{m.catalogue_terms_confirm_help({}, options)}</p>
                    </>
                  ) : (
                    <p>
                      {comparison.state === 'concealed'
                        ? m.catalogue_create_concealed({}, options)
                        : comparison.state === 'denied'
                          ? m.catalogue_result_read_denied({}, options)
                          : m.catalogue_result_read_unavailable({}, options)}
                    </p>
                  )}
                </ContentItemFrame>
              )}
              <Button
                className={actionClassName}
                type="submit"
                disabled={busy || session !== 'signed-in' || (stale && comparison?.state !== 'ready')}
              >
                {busy
                  ? m.correction_saving({}, options)
                  : uncertain
                    ? m.catalogue_create_retry({}, options)
                    : comparison?.state === 'ready'
                      ? m.catalogue_terms_confirm({}, options)
                      : m.catalogue_terms_save({}, options)}
              </Button>
            </form>
          )}
        </>
      )}
    </article>
  );
}

function termValue(snapshot: TermsSnapshot, field: TermField, language: string): string {
  const value = snapshot.subject[field][language];
  return Array.isArray(value) ? value.join('\n') : (value ?? '');
}

function termLanguages(snapshot: TermsSnapshot): string[] {
  return [...new Set(termFields.flatMap((field) => Object.keys(snapshot.subject[field])))];
}
