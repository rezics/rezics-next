import { useEffect, useId, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import {
  identityIntentKey,
  normalizeIdentityQuery,
  readIdentityIntake,
  validIdentityLanguage,
  type IdentityIntakeInput,
  type IdentityIntakePage,
} from './identity-intake';

type Viewer = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type PanelState =
  | { intentKey: string | null; phase: 'idle' | 'loading' }
  | { intentKey: string | null; phase: 'page'; page: IdentityIntakePage }
  | { intentKey: string | null; phase: 'failure' };
type IntakeReader = typeof readIdentityIntake;

export function IdentityIntakePanel({
  locale,
  intent,
  version,
  viewerKey,
  viewerState,
  hasType,
  typeLabel,
  typeCurrent,
  disabled,
  confirmed,
  confirmedUnverified,
  onContinue,
  onClear,
  onRefreshType,
  inputId,
  read = readIdentityIntake,
}: {
  locale: string;
  intent: IdentityIntakeInput | null;
  version: number;
  viewerKey: string;
  viewerState: Viewer;
  hasType: boolean;
  typeLabel?: string;
  typeCurrent: boolean;
  disabled: boolean;
  confirmed: boolean;
  confirmedUnverified: boolean;
  onContinue: (intentKey: string, unverified: boolean) => void;
  onClear: () => void;
  onRefreshType: () => void;
  inputId: string;
  read?: IntakeReader;
}) {
  const options = { locale: locale as never };
  const headingId = useId();
  const intentKey = identityIntentKey(intent, version, viewerKey);
  const currentKey = useRef(intentKey);
  currentKey.current = intentKey;
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const [state, setState] = useState<PanelState>({ intentKey, phase: 'idle' });
  const currentState = state.intentKey === intentKey ? state : { intentKey, phase: 'idle' as const };

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = undefined;
    running.current = false;
    setState({ intentKey, phase: 'idle' });
    return () => controller.current?.abort();
  }, [intentKey]);

  useEffect(() => {
    if (confirmed) document.getElementById('create-subject-submit')?.focus();
  }, [confirmed]);

  async function search() {
    if (!intent || !intentKey || !typeCurrent || disabled || running.current) return;
    const query = normalizeIdentityQuery(intent.q);
    if (!query || !validIdentityLanguage(intent.language)) return;
    controller.current?.abort();
    const requestGeneration = ++generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    running.current = true;
    setState({ intentKey, phase: 'loading' });
    try {
      const page = await read(
        { ...intent, q: query, language: intent.language.trim() },
        requestGeneration,
        requestController.signal,
      );
      if (
        !requestController.signal.aborted &&
        generation.current === requestGeneration &&
        currentKey.current === intentKey
      )
        setState({ intentKey, phase: 'page', page });
    } catch {
      if (
        !requestController.signal.aborted &&
        generation.current === requestGeneration &&
        currentKey.current === intentKey
      )
        setState({ intentKey, phase: 'failure' });
    } finally {
      if (generation.current === requestGeneration) running.current = false;
    }
  }

  function returnToTerms() {
    controller.current?.abort();
    generation.current++;
    running.current = false;
    setState({ intentKey, phase: 'idle' });
    onClear();
    document.getElementById(inputId)?.focus();
  }

  const query = intent ? normalizeIdentityQuery(intent.q) : null;
  const termsReady = !!intent?.q.trim() && !!intent.language.trim();
  const validIntent = !!intentKey && typeCurrent;
  const page = currentState.phase === 'page' ? currentState.page : undefined;
  const loading = currentState.phase === 'loading';
  const failedLocally = currentState.phase === 'failure';
  const retry = failedLocally || page?.actions.retry === true;
  const continueWithResults = page?.actions.continueWithResults === true;
  const continueUnverified = failedLocally || page?.actions.continueUnverified === true;
  const primaryLabel = (hit: IdentityIntakePage['results'][number]) =>
    hit.labels.find((label) => label.language === intent?.language.trim())?.value ??
    hit.labels.find((label) => label.language === locale)?.value ??
    hit.summary?.label?.value ??
    hit.labels[0]?.value ??
    m.identity_intake_metadata_unavailable({}, options);

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-muted/20 p-4 sm:p-5"
    >
      <div className="min-w-0 space-y-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {m.identity_intake_heading({}, options)}
        </h2>
        <p className="text-sm text-muted-foreground">{m.identity_intake_help({}, options)}</p>
        {typeLabel ? (
          <p className="break-words text-sm">
            <span className="font-medium">{m.catalogue_create_type({}, options)}:</span> {typeLabel}
          </p>
        ) : null}
      </div>

      {!hasType ? <p role="status">{m.identity_intake_choose_type({}, options)}</p> : null}
      {hasType && !typeCurrent ? <p role="alert">{m.identity_intake_changed({}, options)}</p> : null}
      {hasType && typeCurrent && !termsReady ? <p role="status">{m.identity_intake_enter_terms({}, options)}</p> : null}
      {hasType && typeCurrent && termsReady && !query ? (
        <p role="alert">{m.identity_intake_invalid({}, options)}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!retry ? (
          <Button type="button" size="lg" disabled={!validIntent || disabled || loading} onClick={() => void search()}>
            {loading ? m.identity_intake_searching({}, options) : m.identity_intake_search({}, options)}
          </Button>
        ) : null}
        {retry ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={disabled || loading}
            onClick={() => (page?.status === 'stale' ? onRefreshType() : void search())}
          >
            {m.identity_intake_retry({}, options)}
          </Button>
        ) : null}
      </div>
      {loading ? (
        <p role="status" aria-live="polite">
          {m.identity_intake_searching({}, options)}
        </p>
      ) : null}

      {(page?.viewer.state === 'signed-out' && page.status !== 'signed-out') ||
      (!page && failedLocally && viewerState === 'signed-out') ? (
        <p role="status">{m.identity_intake_signed_out({}, options)}</p>
      ) : null}
      {page?.status === 'empty' ? <p role="status">{m.identity_intake_empty({}, options)}</p> : null}
      {page?.status === 'partial' ? <p role="status">{m.identity_intake_partial({}, options)}</p> : null}
      {page?.status === 'unavailable' || failedLocally ? (
        <p role="alert">{m.identity_intake_unavailable({}, options)}</p>
      ) : null}
      {page?.status === 'denied' ? <p role="alert">{m.identity_intake_denied({}, options)}</p> : null}
      {page?.status === 'signed-out' ? <p role="alert">{m.identity_intake_signed_out({}, options)}</p> : null}
      {page?.status === 'stale' ? <p role="alert">{m.identity_intake_changed({}, options)}</p> : null}
      {page?.status === 'invalid' ? <p role="alert">{m.identity_intake_invalid({}, options)}</p> : null}
      {page?.viewer.state === 'unavailable' || viewerState === 'unavailable' ? (
        <p role="status">{m.catalogue_create_unavailable({}, options)}</p>
      ) : null}

      {page?.results.length ? (
        <div role="region" aria-label={m.identity_intake_results({}, options)} className="min-w-0 space-y-3">
          <h3 className="text-base font-semibold">{m.identity_intake_results({}, options)}</h3>
          <ul className="grid min-w-0 gap-3">
            {page.results.map((hit) => {
              const label = primaryLabel(hit);
              const alternateLabels = hit.labels.filter((entry) => entry.value !== label);
              const typeLabel = hit.typeLabel ?? m.identity_intake_metadata_unavailable({}, options);
              const linkLabel = hit.labels[0]?.value ?? hit.summary?.label?.value ?? hit.id;
              const grain = hit.summary
                ? hit.summary.creativeWork
                  ? m.identity_intake_grain_work({}, options)
                  : m.identity_intake_grain_item({}, options)
                : m.identity_intake_grain_unavailable({}, options);
              const href = subjectHref({ id: hit.id, label: linkLabel }, locale).href;
              return (
                <li key={hit.id} className="min-w-0 rounded-lg border border-border bg-background p-3 sm:p-4">
                  <article aria-labelledby={`identity-hit-${hit.id}`} className="min-w-0 space-y-3">
                    <div className="min-w-0 space-y-1">
                      <h4
                        id={`identity-hit-${hit.id}`}
                        lang={hit.labels[0]?.language}
                        className="break-words font-medium"
                      >
                        {label}
                      </h4>
                      <p className="break-words text-sm text-muted-foreground">
                        {m.catalogue_create_type({}, options)}: {typeLabel} · {grain}
                      </p>
                      {alternateLabels.length ? (
                        <div className="min-w-0 text-sm">
                          <p className="font-medium">{m.identity_intake_other_labels({}, options)}</p>
                          <ul className="grid min-w-0 gap-1">
                            {alternateLabels.map((entry) => (
                              <li
                                key={`${entry.language}-${entry.value}`}
                                lang={entry.language}
                                className="break-words"
                              >
                                {entry.value} <span className="text-muted-foreground">({entry.language})</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>

                    {hit.summary ? (
                      <div className="min-w-0 text-sm">
                        <p className="font-medium">{m.identity_intake_summary({}, options)}</p>
                        {hit.summary?.label ? (
                          <p lang={hit.summary.label.language} className="break-words">
                            {hit.summary.label.value}
                          </p>
                        ) : null}
                        {!hit.summary.label ? <p>{m.identity_intake_metadata_unavailable({}, options)}</p> : null}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {m.identity_intake_metadata_unavailable({}, options)}
                      </p>
                    )}

                    <a
                      className={buttonVariants({ variant: 'outline', size: 'lg' })}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {m.identity_intake_open({}, options)}
                      <span className="sr-only"> · {m.guide_new_tab({}, options)}</span>
                    </a>
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {page?.actions.createAuthority === 'unknown' ? (
        <p className="text-sm text-muted-foreground">{m.identity_intake_authority_unknown({}, options)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {continueWithResults && intentKey ? (
          <Button type="button" size="lg" disabled={disabled || confirmed} onClick={() => onContinue(intentKey, false)}>
            {m.identity_intake_continue({}, options)}
          </Button>
        ) : null}
        {continueUnverified && intentKey ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={disabled || confirmed}
            onClick={() => onContinue(intentKey, true)}
          >
            {m.identity_intake_unverified({}, options)}
          </Button>
        ) : null}
        {confirmed ? (
          <p role="status" className="min-h-11 content-center text-sm">
            {confirmedUnverified ? m.identity_intake_unverified({}, options) : m.identity_intake_continue({}, options)}
          </p>
        ) : null}
        {currentState.phase !== 'idle' ? (
          <Button type="button" size="lg" variant="ghost" disabled={disabled} onClick={returnToTerms}>
            {m.identity_intake_return({}, options)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
