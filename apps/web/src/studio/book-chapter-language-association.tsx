import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { canonicalLanguageKey, MAX_LANGUAGE_KEY_LENGTH } from '@rezics/definitions/language';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { ExactVersionDetails } from './revisions';
import { sameExact, type StudioRevision } from './contract';
import type { StudioController, StudioState } from './controller';
import { HostedSourceConsentView } from './hosted-source-consent-view';
import type { HostedSourceConsentVisit, SourceConsentState } from './hosted-source-consent';
const noConsentSubscription = () => () => {};
const noConsentSnapshot = () => null;

function candidate(state: StudioState): StudioRevision | null {
  const selected = state.selected;
  if (!selected || selected.dirty || selected.snapshotPending || selected.invalid || selected.uploading) return null;
  const historical = state.historical;
  return historical &&
    state.inspectedVersion &&
    sameExact(historical.exact, state.inspectedVersion) &&
    historical.exact.postId === selected.source.revision.exact.postId
    ? historical
    : selected.source.revision;
}

/** Bind an admitted saved version; ordinary draft selection/history remain with the shared Studio. */
export function BookChapterLanguageAssociation({
  controller,
  state,
  occurrenceId,
  active,
  onDirty,
  onSaved,
  onCancel,
}: {
  controller: StudioController;
  state: StudioState;
  occurrenceId: string;
  active: boolean;
  onDirty: () => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId(),
    locale = getLocale(),
    options = { locale };
  const source = candidate(state);
  const structure = state.structure;
  const chapter = structure?.placements.find((row) => row.occurrenceId === occurrenceId);
  const [basis] = useState(structure?.revision);
  const [language, setLanguage] = useState('');
  const [title, setTitle] = useState(source?.title ?? chapter?.title ?? '');
  const [makeDefault, setMakeDefault] = useState(false);
  const [sending, setSending] = useState(false);
  const [consent, setConsent] = useState<{ key: string; visit: HostedSourceConsentVisit } | null>(null);
  const [consentFailure, setConsentFailure] = useState<string | null>(null);
  const [consentRetry, setConsentRetry] = useState(0);
  const sourceKey = source ? JSON.stringify(source.exact) : '';
  const admitted = controller.current();
  useEffect(() => {
    if (!source || !admitted) return;
    let live = true,
      created: HostedSourceConsentVisit | null = null;
    const request = new AbortController();
    setConsent(null);
    setConsentFailure(null);
    void controller
      .createBookSourceConsent(source.exact, request.signal)
      .then((result) => {
        if (!result.ok) {
          if (live && !request.signal.aborted) setConsentFailure(sourceKey);
          return;
        }
        created = result.value;
        if (!live || request.signal.aborted || !controller.current()) {
          created.dispose();
          return;
        }
        setConsent({ key: sourceKey, visit: created });
      })
      .catch(() => {
        if (live && !request.signal.aborted) setConsentFailure(sourceKey);
      });
    return () => {
      live = false;
      request.abort();
      created?.dispose();
    };
  }, [controller, sourceKey, admitted, consentRetry]);
  const consentVisit = consent?.key === sourceKey ? consent.visit : null;
  const consentState = useSyncExternalStore<SourceConsentState | null>(
    consentVisit?.subscribe ?? noConsentSubscription,
    consentVisit?.snapshot ?? noConsentSnapshot,
    consentVisit?.snapshot ?? noConsentSnapshot,
  );
  const consentBusy =
    consentState?.kind === 'active' && (consentState.phase === 'working' || consentState.phase === 'uncertain');
  const changed = !structure || structure.revision !== basis || state.issue?.kind === 'stale';
  const unresolved = controller.hasUnresolvedCommand();
  const busy = sending || state.operation !== null;
  const canonicalDefault = Boolean(
    source && chapter?.target.kind === 'chapter' && sameExact(source.exact, chapter.target.document),
  );
  const allowed =
    active &&
    controller.current() &&
    controller.canBindChapterLanguage() &&
    chapter?.target.kind === 'chapter' &&
    !busy &&
    !unresolved &&
    !consentBusy;
  const valid = Boolean(
    allowed &&
    !changed &&
    source &&
    canonicalLanguageKey(language) === language &&
    title.trim() &&
    [...title.trim()].length <= 256 &&
    (!(makeDefault || language === chapter?.defaultLanguage) || canonicalDefault),
  );
  async function submit() {
    const live = controller.snapshot(),
      selected = candidate(live);
    if (
      !valid ||
      !source ||
      !selected ||
      !sameExact(source.exact, selected.exact) ||
      live.structure?.revision !== basis
    )
      return;
    setSending(true);
    const result = await controller.organize({
      kind: 'bind-language',
      occurrenceId,
      language,
      title: title.trim(),
      document: source.exact,
      makeDefault,
    });
    setSending(false);
    if (result) onSaved();
  }
  if (!controller.current()) return <p role="status">{m.studio_books_ended({}, options)}</p>;
  return (
    <form
      className="studio-stack"
      aria-label={m.studio_book_language_heading({}, options)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>{m.studio_book_language_heading({}, options)}</h3>
      <p className="studio-help">{m.studio_book_language_help({}, options)}</p>
      {chapter ? <p>{chapter.title}</p> : null}
      {source ? (
        <section aria-label={m.studio_book_language_source({}, options)} className="studio-stack">
          <h4>{m.studio_book_language_source({}, options)}</h4>
          <p>{source.title}</p>
          <p className="studio-help">
            {state.historical && sameExact(state.historical.exact, source.exact)
              ? m.studio_book_language_historical({}, options)
              : m.studio_book_language_saved({}, options)}
          </p>
          <ExactVersionDetails exact={source.exact} />
        </section>
      ) : (
        <p role="status">{m.studio_book_language_choose({}, options)}</p>
      )}
      {consentFailure === sourceKey && sourceKey ? (
        <div className="studio-stack">
          <p role="status">{m.studio_source_consent_unavailable({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={!active || busy || unresolved}
            onClick={() => setConsentRetry((value) => value + 1)}
          >
            {m.correction_retry({}, options)}
          </Button>
        </div>
      ) : null}
      {consentVisit ? (
        <HostedSourceConsentView
          visit={consentVisit}
          bookTitle={controller.input.title}
          locale={locale}
          disabled={!active || busy || unresolved}
        />
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${id}-language`}>{m.studio_book_language_key({}, options)}</FieldLabel>
        <Input
          id={`${id}-language`}
          value={language}
          maxLength={MAX_LANGUAGE_KEY_LENGTH}
          disabled={!allowed || changed}
          autoComplete="off"
          onChange={(event) => {
            setLanguage(event.target.value);
            onDirty();
          }}
          onBlur={() => {
            const value = canonicalLanguageKey(language);
            if (value) setLanguage(value);
          }}
        />
        <FieldDescription>{m.studio_book_language_key_help({}, options)}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-title`}>{m.studio_book_language_title({}, options)}</FieldLabel>
        <Input
          id={`${id}-title`}
          value={title}
          maxLength={512}
          disabled={!allowed || changed}
          onChange={(event) => {
            setTitle(event.target.value);
            onDirty();
          }}
        />
      </Field>
      <div className="studio-stack">
        <Button
          type="button"
          variant={makeDefault ? 'secondary' : 'outline'}
          className="min-h-11 whitespace-normal"
          aria-pressed={makeDefault}
          disabled={!allowed || changed || !canonicalDefault}
          onClick={() => {
            setMakeDefault((value) => !value);
            onDirty();
          }}
        >
          {m.studio_book_language_default({}, options)}
        </Button>
        <p className="studio-help">{m.studio_book_language_default_help({}, options)}</p>
      </div>
      {changed ? <p role="status">{m.studio_book_language_changed({}, options)}</p> : null}
      {unresolved && !busy ? (
        <div className="studio-stack">
          <p role="status">{m.studio_book_language_uncertain({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={!active}
            onClick={async () => {
              if (await controller.retry()) onSaved();
            }}
          >
            {m.studio_book_language_retry({}, options)}
          </Button>
        </div>
      ) : null}
      <div className="studio-action-row">
        <Button type="submit" disabled={!valid}>
          {busy ? m.studio_book_language_sending({}, options) : m.studio_book_language_bind({}, options)}
        </Button>
        <Button type="button" variant="outline" disabled={busy || unresolved || consentBusy} onClick={onCancel}>
          {m.action_cancel({}, options)}
        </Button>
      </div>
      <p className="studio-help">{m.studio_book_language_private({}, options)}</p>
    </form>
  );
}
