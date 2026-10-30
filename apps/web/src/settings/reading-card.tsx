import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  FieldSet,
  FieldLegend,
} from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { readSettingsPage, savePreferences } from './actions';
import type { NativePreferenceFailure, PreferenceChange, ReadingPreferences, SpoilerLevel } from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import {
  readingMutation,
  readReading,
  sameReading,
  sendReading,
  type ReadingIO,
  type ReadingValues,
} from './reading-preferences';

const levels: { value: SpoilerLevel; title: () => string; text: () => string }[] = [
  { value: 0, title: () => m.settings_spoiler_0_title(), text: () => m.settings_spoiler_0_text() },
  { value: 1, title: () => m.settings_spoiler_1_title(), text: () => m.settings_spoiler_1_text() },
  { value: 2, title: () => m.settings_spoiler_2_title(), text: () => m.settings_spoiler_2_text() },
];

type ReadingState = {
  known: ReadingPreferences;
  draft: ReadingValues;
  pending: Readonly<PreferenceChange> | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  reason?: string | undefined;
  failure?: NativePreferenceFailure | undefined;
};

export function ReadingCard({
  initial,
  version,
  csrfToken,
  onVersionChange,
  io,
}: {
  initial: ReadingPreferences;
  version: number;
  csrfToken: string | null;
  onVersionChange: (version: number) => void;
  io?: ReadingIO;
}) {
  const ids = useId();
  const [hydrated, setHydrated] = useState(false);
  useLayoutEffect(() => setHydrated(true), []);
  const [state, setState] = useState<ReadingState>(() => ({
    known: initial,
    draft: initial,
    pending: null,
    phase: 'idle',
  }));
  const current = useRef(state);
  const waiting = usePreferenceRetry(state.failure);
  const draftRevision = useRef(0);
  const sharedVersion = useRef(version);
  sharedVersion.current = Math.max(sharedVersion.current, version, initial.version);
  const transport = io ?? {
    save: (data: Readonly<PreferenceChange>) => savePreferences({ data, headers: csrfHeaders() }),
    read: () => readSettingsPage(),
  };
  function update(patch: Partial<ReadingState>) {
    current.current = { ...current.current, ...patch };
    setState(current.current);
  }
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  async function send(recovering: boolean) {
    const input = current.current.pending;
    if (!input) return;
    update({ phase: 'saving', reason: undefined, failure: undefined });
    const result = await sendReading(transport, input, recovering, () => sharedVersion.current);
    if (result.kind !== 'confirmed') {
      update({
        pending: result.kind === 'uncertain' ? input : null,
        phase: result.kind === 'uncertain' ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        failure: result.failure,
      });
      return;
    }
    const { preferences, receipt } = result;
    // Controls always keep the latest draft, including edits made while saving or resolving a response.
    const matches = sameReading(current.current.draft, preferences) && preferences.version === receipt.version;
    update({ known: preferences, pending: null, phase: matches ? 'saved' : 'review', failure: undefined });
    onVersionChange(Math.max(sharedVersion.current, preferences.version));
  }
  async function submit() {
    if (!hydrated || !csrfToken || current.current.pending || current.current.phase === 'reloading') return;
    if (sharedVersion.current > current.current.known.version) {
      update({ phase: 'conflict' });
      return;
    }
    const input = readingMutation(current.current.known, current.current.draft);
    if (!input) {
      update({ phase: 'idle' });
      return;
    }
    update({ pending: input });
    await send(false);
  }
  async function edit(next: Partial<ReadingValues>) {
    if (!hydrated || !csrfToken) return;
    const autosave = current.current.phase === 'idle' || current.current.phase === 'saved';
    draftRevision.current++;
    update({ draft: { ...current.current.draft, ...next } });
    if (autosave && !current.current.pending) await submit();
  }
  async function reload(keepDraft = false) {
    if (waiting || current.current.phase === 'saving' || current.current.phase === 'reloading') return;
    const revision = draftRevision.current;
    update({ phase: 'reloading', failure: undefined });
    const result = await readReading(transport, () => Math.max(current.current.known.version, sharedVersion.current));
    if (!result.ok) {
      update({
        phase: current.current.pending ? 'uncertain' : 'failed',
        reason: result.reason,
        failure: result.failure,
      });
      return;
    }
    // Reload discards a definitely rejected draft. An unresolved save still needs its original retry;
    // review and edits made after the read started must keep their own choices.
    const preserve = keepDraft || current.current.pending !== null || draftRevision.current !== revision;
    update({
      known: result.preferences,
      ...(preserve ? {} : { draft: result.preferences }),
      phase: current.current.pending ? 'uncertain' : preserve ? 'review' : 'idle',
      reason: undefined,
      failure: undefined,
    });
    onVersionChange(Math.max(sharedVersion.current, result.preferences.version));
  }
  async function retry() {
    if (waiting || !hydrated || !csrfToken || current.current.phase !== 'uncertain') return;
    await send(true);
  }
  const uncertain = state.pending !== null && state.phase !== 'saving';
  const recovery = uncertain || ['conflict', 'review', 'failed', 'reloading'].includes(state.phase);
  const title = uncertain
    ? m.settings_reading_uncertain_title()
    : state.phase === 'review'
      ? m.settings_reading_review_title()
      : state.reason === 'closed'
        ? m.settings_closed_title()
        : state.reason === 'preparing'
          ? m.settings_preparing_title()
          : state.reason === 'unavailable'
            ? m.settings_unavailable_title()
            : state.phase === 'failed'
              ? m.settings_failed_title()
              : m.settings_conflict_title();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_reading_text()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <FieldSet>
            <FieldLegend id={`${ids}-spoilers`}>{m.settings_spoiler_legend()}</FieldLegend>
            <FieldDescription>{m.settings_spoiler_text()}</FieldDescription>
            <RadioGroup
              value={String(state.draft.spoilerLevel)}
              disabled={!hydrated || !csrfToken}
              onValueChange={(value) => void edit({ spoilerLevel: Number(value) as SpoilerLevel })}
              aria-labelledby={`${ids}-spoilers`}
            >
              {levels.map((level) => (
                <FieldLabel key={level.value} htmlFor={`${ids}-level-${level.value}`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle id={`${ids}-level-${level.value}-title`}>{level.title()}</FieldTitle>
                      <FieldDescription id={`${ids}-level-${level.value}-text`}>{level.text()}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem
                      id={`${ids}-level-${level.value}`}
                      value={String(level.value)}
                      aria-labelledby={`${ids}-level-${level.value}-title`}
                      aria-describedby={`${ids}-level-${level.value}-text`}
                    />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
          <FieldLabel htmlFor={`${ids}-suitability`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle id={`${ids}-suitability-title`}>{m.settings_suitability_title()}</FieldTitle>
                <FieldDescription id={`${ids}-suitability-text`}>{m.settings_suitability_text()}</FieldDescription>
              </FieldContent>
              <Switch
                id={`${ids}-suitability`}
                checked={state.draft.suitability === 'show'}
                disabled={!hydrated || !csrfToken}
                onCheckedChange={(checked) => void edit({ suitability: checked ? 'show' : 'blur' })}
                aria-labelledby={`${ids}-suitability-title`}
                aria-describedby={`${ids}-suitability-text`}
              />
            </Field>
          </FieldLabel>
        </FieldGroup>
        <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {state.phase === 'saving' ? m.settings_saving() : null}
          {state.phase === 'saved' ? m.settings_saved() : null}
        </div>
        {recovery ? (
          <Alert
            data-response-status={state.failure?.status ?? ''}
            data-response-code={state.failure?.code ?? ''}
            data-retry-after={state.failure?.retryAfter}
          >
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>
                {uncertain
                  ? m.settings_reading_uncertain_text()
                  : state.phase === 'review'
                    ? m.settings_reading_review_text()
                    : state.reason === 'closed'
                      ? m.settings_closed_text()
                      : state.reason === 'preparing'
                        ? m.settings_preparing_text()
                        : state.reason === 'unavailable'
                          ? m.settings_unavailable_text()
                          : state.phase === 'failed'
                            ? m.settings_failed_text()
                            : m.settings_conflict_text()}
              </p>
              {uncertain && state.reason === 'closed' ? <p>{m.settings_closed_text()}</p> : null}
              {uncertain && state.reason === 'preparing' ? <p>{m.settings_preparing_text()}</p> : null}
              {uncertain && state.reason === 'unavailable' ? <p>{m.settings_unavailable_text()}</p> : null}
              {waiting ? <p>{m.settings_retry_wait()}</p> : null}
              <p>
                {m.settings_reading_current({
                  spoilers: levels[state.known.spoilerLevel]!.title(),
                  images: state.known.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                {uncertain ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={waiting || busy || !csrfToken}
                    onClick={() => void retry()}
                  >
                    {m.settings_reading_retry_original()}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" disabled={waiting || busy} onClick={() => void reload()}>
                  {m.settings_reload()}
                </Button>
                {!state.pending && (state.phase === 'conflict' || state.phase === 'failed') ? (
                  <Button type="button" variant="outline" disabled={waiting || busy} onClick={() => void reload(true)}>
                    {m.settings_reading_review_changes()}
                  </Button>
                ) : null}
                {state.phase === 'review' ? (
                  <>
                    <Button
                      type="button"
                      disabled={!csrfToken || sameReading(state.known, state.draft)}
                      onClick={() => void submit()}
                    >
                      {m.settings_reading_save_draft()}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        update({ draft: state.known, phase: 'idle', failure: undefined, reason: undefined })
                      }
                    >
                      {m.settings_reading_use_current()}
                    </Button>
                  </>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
