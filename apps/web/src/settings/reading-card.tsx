import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { readSettingsPage, savePreferences } from './actions';
import type {
  NativePreferenceFailure,
  PreferenceChange,
  ReadingAdvice,
  ReadingPreferences,
  SpoilerLevel,
} from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import { readingNeedsNavigationDecision, useSettingsNavigationDraft } from './reading-navigation';
import {
  ownerMayChangeReading,
  readingMutation,
  readingReset,
  readReading,
  sameReading,
  sendReading,
  type ReadingIO,
  type ReadingValues,
} from './reading-preferences';
import { useSettingsCurrent, useSettingsReadCurrent } from './settings-session-owner';

const preferenceActionClassName = 'h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal wrap-anywhere';

const levels: {
  value: SpoilerLevel;
  title: () => string;
  text: () => string;
}[] = [
  {
    value: 0,
    title: () => m.settings_spoiler_0_title(),
    text: () => m.settings_spoiler_0_text(),
  },
  {
    value: 1,
    title: () => m.settings_spoiler_1_title(),
    text: () => m.settings_spoiler_1_text(),
  },
  {
    value: 2,
    title: () => m.settings_spoiler_2_title(),
    text: () => m.settings_spoiler_2_text(),
  },
];

type ReadingState = {
  known: ReadingPreferences;
  draft: ReadingValues;
  pending: Readonly<PreferenceChange> | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  knownCurrent: boolean;
  advice?: ReadingAdvice | undefined;
  failureOrigin?: 'read' | undefined;
  reason?: string | undefined;
  failure?: NativePreferenceFailure | undefined;
};

/** Reading keeps the editable draft separate from both confirmed values and an immutable original write. */
export class ReadingDraftRecovery {
  private state: ReadingState;
  private listeners = new Set<() => void>();
  constructor(
    initial: ReadingPreferences,
    private io: ReadingIO,
    private owner: {
      canRead: () => boolean;
      canWrite: () => boolean;
      version: () => number;
      onVersionChange: (version: number) => void;
    },
  ) {
    this.state = {
      known: initial,
      draft: initial,
      pending: null,
      phase: 'idle',
      knownCurrent: true,
      advice: initial.advice,
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ReadingState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private async send(recovering: boolean) {
    const input = this.state.pending;
    if (!input || !this.owner.canWrite()) return;
    this.update({
      phase: 'saving',
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
      knownCurrent: false,
    });
    const result = await sendReading(this.io, input, recovering, () => this.owner.version());
    if (!this.owner.canWrite()) return;
    if (result.kind !== 'confirmed') {
      this.update({
        pending: result.kind === 'uncertain' ? input : null,
        phase: result.kind === 'uncertain' ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        failure: result.failure,
        failureOrigin: result.kind === 'uncertain' ? result.operation : undefined,
      });
      return;
    }
    const { preferences, receipt } = result;
    // Controls always keep the latest draft, including edits made while saving or resolving a response.
    const matches = sameReading(this.state.draft, preferences) && preferences.version === receipt.version;
    this.update({
      known: preferences,
      knownCurrent: true,
      pending: null,
      phase: matches ? 'saved' : 'review',
      failure: undefined,
      advice: preferences.advice,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), preferences.version));
  }
  async submit() {
    if (!this.owner.canWrite() || this.state.pending || this.state.phase === 'reloading') return;
    if (this.owner.version() > this.state.known.version) {
      this.update({
        phase: 'conflict',
        knownCurrent: false,
        failureOrigin: undefined,
        reason: undefined,
        failure: undefined,
      });
      return;
    }
    const input = readingMutation(this.state.known, this.state.draft);
    if (!input) {
      this.update({ phase: 'idle' });
      return;
    }
    this.update({ pending: input });
    await this.send(false);
  }
  async edit(next: Partial<ReadingValues>) {
    if (!this.owner.canWrite()) return;
    const supported = this.state.advice?.reading.supported;
    if (next.spoilerLevel !== undefined && supported && !supported.spoilerLevels.includes(next.spoilerLevel)) return;
    if (next.suitability !== undefined && supported && !supported.suitability.includes(next.suitability)) return;
    const autosave = this.state.phase === 'idle' || this.state.phase === 'saved';
    this.update({ draft: { ...this.state.draft, ...next } });
    if (autosave && !this.state.pending) await this.submit();
  }
  async resetToNativeDefaults() {
    if (!this.owner.canWrite() || this.state.pending || this.state.phase === 'reloading') return;
    if (this.owner.version() > this.state.known.version) {
      this.update({
        phase: 'conflict',
        knownCurrent: false,
        failureOrigin: undefined,
        reason: undefined,
        failure: undefined,
      });
      return;
    }
    const input = readingReset(this.state.known);
    if (!input) {
      this.update({ phase: 'idle', draft: this.state.known });
      return;
    }
    this.update({ draft: { spoilerLevel: 0, suitability: 'blur' }, pending: input });
    await this.send(false);
  }
  async reload(waiting = false) {
    if (!this.owner.canRead() || waiting || this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    this.update({
      phase: 'reloading',
      knownCurrent: false,
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
    });
    const result = await readReading(this.io, () => Math.max(this.state.known.version, this.owner.version()));
    if (!this.owner.canRead()) return;
    if (!result.ok) {
      this.update({
        phase: this.state.pending ? 'uncertain' : 'failed',
        reason: result.reason,
        failure: result.failure,
        failureOrigin: 'read',
      });
      return;
    }
    // A current-value read only updates the comparison baseline. Even a definitely rejected
    // write leaves a draft that the person must explicitly save or discard after review.
    this.update({
      known: result.preferences,
      knownCurrent: true,
      phase: this.state.pending ? 'uncertain' : 'review',
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
      advice: result.preferences.advice,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), result.preferences.version));
  }
  useCurrent() {
    if (!this.owner.canRead() || this.state.pending || this.state.phase !== 'review' || !this.state.knownCurrent)
      return;
    // Discard is deliberate and local; it cannot settle an unresolved original or submit a write.
    this.update({
      draft: this.state.known,
      phase: 'idle',
      failure: undefined,
      reason: undefined,
      failureOrigin: undefined,
    });
  }
  async retry(waiting = false) {
    if (waiting || !this.owner.canWrite() || this.state.phase !== 'uncertain') return;
    await this.send(true);
  }
}

function readingLabel(values: ReadingValues) {
  return {
    spoilers: levels[values.spoilerLevel]!.title(),
    images: values.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
  };
}

function ReadingPreview({ ids, draft, confirmed }: { ids: string; draft: ReadingValues; confirmed: ReadingValues }) {
  const draftPreview = !sameReading(draft, confirmed);
  const values = draftPreview ? draft : confirmed;
  return (
    <figure className="min-w-0 max-w-full rounded-lg border border-border p-3" aria-labelledby={`${ids}-preview`}>
      <figcaption id={`${ids}-preview`} className="text-sm font-medium">
        {m.settings_reading_preview_legend()}
      </figcaption>
      <p className="text-sm text-muted-foreground">
        {draftPreview ? m.settings_reading_preview_draft() : m.settings_reading_preview_confirmed()}
      </p>
      <p className="mt-2 font-medium">{m.settings_reading_preview_title()}</p>
      <p className="text-sm">{m.settings_reading_preview_summary()}</p>
      <p className="text-sm" data-spoiler="minor">
        {values.spoilerLevel >= 1 ? m.settings_reading_preview_minor() : m.settings_reading_preview_hidden()}
      </p>
      <p className="text-sm" data-spoiler="major">
        {values.spoilerLevel >= 2 ? m.settings_reading_preview_major() : m.settings_reading_preview_hidden()}
      </p>
      <div
        className={`mt-2 max-w-40 rounded-md bg-muted p-6 text-center text-sm ${values.suitability === 'blur' ? 'blur-sm' : ''}`}
        aria-hidden="true"
      >
        {m.settings_reading_preview_cover()}
      </div>
      <p className="sr-only">
        {values.suitability === 'blur' ? m.settings_reading_preview_cover_blur() : m.settings_reading_preview_cover()}
      </p>
    </figure>
  );
}

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
  const isCurrent = useSettingsCurrent(csrfToken, !!io);
  const readCurrent = useSettingsReadCurrent(csrfToken, !!io);
  const lifetime = useRef({ active: false, retired: false });
  const mounted = () => lifetime.current.active && !lifetime.current.retired;
  useLayoutEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
      queueMicrotask(() => {
        if (!lifetime.current.active) lifetime.current.retired = true;
      });
    };
  }, []);
  const sharedVersion = useRef(version);
  sharedVersion.current = Math.max(sharedVersion.current, version, initial.version);
  const source = io ?? {
    save: (data: Readonly<PreferenceChange>) => savePreferences({ data, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
    read: () => readSettingsPage(),
  };
  // sendReading can perform a second recovery GET internally; guard that boundary as well.
  const transport: ReadingIO = {
    save: async (input) => {
      if (!csrfToken || !isCurrent()) throw new Error('Settings viewer unavailable');
      const result = await source.save(input);
      if (!isCurrent()) throw new Error('Settings viewer changed');
      return result;
    },
    read: async () => {
      if (!readCurrent()) throw new Error('Settings viewer unavailable');
      const result = await source.read();
      if (!readCurrent()) throw new Error('Settings viewer changed');
      return result;
    },
  };
  const credentialed = hydrated && !!csrfToken;
  const adviceRef = useRef(initial.advice);
  const latest = useRef({
    transport,
    isCurrent,
    readCurrent,
    onVersionChange,
    credentialed,
  });
  latest.current = {
    transport,
    isCurrent,
    readCurrent,
    onVersionChange,
    credentialed,
  };
  const [editor] = useState(
    () =>
      new ReadingDraftRecovery(
        initial,
        {
          save: (input) => latest.current.transport.save(input),
          read: () => latest.current.transport.read(),
        },
        {
          canWrite: () =>
            mounted() &&
            latest.current.credentialed &&
            latest.current.isCurrent() &&
            ownerMayChangeReading(adviceRef.current),
          canRead: () => mounted() && latest.current.readCurrent(),
          version: () => sharedVersion.current,
          onVersionChange: (next) => latest.current.onVersionChange(next),
        },
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  adviceRef.current = state.advice;
  const ownerMayChange = ownerMayChangeReading(state.advice);
  const mayWrite = credentialed && ownerMayChange;
  const offered = state.advice?.reading.supported.spoilerLevels ?? [];
  const offeredImages = state.advice?.reading.supported.suitability ?? [];
  const choicesReady = offered.length > 0 && offeredImages.length > 0;
  useSettingsNavigationDraft(
    'reading',
    readingNeedsNavigationDecision(state),
    () => mounted() && isCurrent() && readingNeedsNavigationDecision(editor.snapshot()),
  );
  const waiting = usePreferenceRetry(state.failure);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const uncertain = state.pending !== null && state.phase !== 'saving';
  const readLoading = state.phase === 'reloading';
  const readFailed = state.failureOrigin === 'read';
  const recovery = uncertain || ['conflict', 'review', 'failed', 'reloading'].includes(state.phase);
  const readTitle =
    state.reason === 'closed'
      ? m.settings_reading_read_closed_title()
      : state.reason === 'forbidden'
        ? m.settings_reading_read_denied_title()
        : m.settings_reading_read_unavailable_title();
  const readText =
    state.reason === 'closed'
      ? m.settings_reading_read_closed_text()
      : state.reason === 'forbidden'
        ? m.settings_reading_read_denied_text()
        : m.settings_reading_read_unavailable_text();
  const title = readLoading
    ? m.settings_reading_loading()
    : readFailed
      ? readTitle
      : uncertain
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
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle>
          <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_reading_text()}</CardDescription>
        {choicesReady ? (
          <CardDescription>
            {ownerMayChange ? m.settings_automatic_save_help() : m.settings_reading_read_only_text()}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {choicesReady ? (
          <>
            <FieldGroup>
              <FieldSet>
                <FieldLegend id={`${ids}-spoilers`}>{m.settings_spoiler_legend()}</FieldLegend>
                <FieldDescription>{m.settings_spoiler_text()}</FieldDescription>
                <RadioGroup
                  value={String(state.draft.spoilerLevel)}
                  disabled={!mayWrite}
                  onValueChange={(value) =>
                    void editor.edit({
                      spoilerLevel: Number(value) as SpoilerLevel,
                    })
                  }
                  aria-labelledby={`${ids}-spoilers`}
                >
                  {levels
                    .filter((level) => offered.includes(level.value))
                    .map((level) => (
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
              {offeredImages.includes('blur') || offeredImages.includes('show') ? (
                <FieldLabel htmlFor={`${ids}-suitability`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle id={`${ids}-suitability-title`}>{m.settings_suitability_title()}</FieldTitle>
                      <FieldDescription id={`${ids}-suitability-text`}>
                        {m.settings_suitability_text()}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id={`${ids}-suitability`}
                      checked={state.draft.suitability === 'show'}
                      disabled={!mayWrite}
                      onCheckedChange={(checked) => void editor.edit({ suitability: checked ? 'show' : 'blur' })}
                      aria-labelledby={`${ids}-suitability-title`}
                      aria-describedby={`${ids}-suitability-text`}
                    />
                  </Field>
                </FieldLabel>
              ) : null}
            </FieldGroup>
            <p className="text-sm text-muted-foreground">
              {m.settings_reading_effective({
                ...readingLabel(state.known),
                defaultSpoilers: levels[0]!.title(),
                defaultImages: m.settings_reading_blur(),
              })}
            </p>
            <ReadingPreview ids={ids} draft={state.draft} confirmed={state.known} />
            {ownerMayChange && !recovery && (state.known.spoilerLevel !== 0 || state.known.suitability !== 'blur') ? (
              <Button
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={busy || !mayWrite}
                onClick={() => void editor.resetToNativeDefaults()}
              >
                {m.settings_reading_reset()}
              </Button>
            ) : null}
          </>
        ) : (
          <Alert>
            <AlertTitle>{m.settings_reading_choices_unavailable_title()}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>{m.settings_reading_choices_unavailable_text()}</p>
              <Button
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={waiting || busy}
                onClick={() => void editor.reload(waiting)}
              >
                {m.settings_reload()}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {choicesReady && !ownerMayChange && state.advice ? (
          <Alert>
            <AlertTitle>{m.settings_reading_read_only_title()}</AlertTitle>
            <AlertDescription>{m.settings_reading_read_only_text()}</AlertDescription>
          </Alert>
        ) : null}
        <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {state.phase === 'saving' ? m.settings_saving() : null}
          {state.phase === 'saved' ? m.settings_saved() : null}
        </div>
        {recovery ? (
          <Alert
            role={readLoading ? 'status' : 'alert'}
            data-response-status={state.failure?.status ?? ''}
            data-response-code={state.failure?.code ?? ''}
            data-retry-after={state.failure?.retryAfter}
          >
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>
                {readLoading
                  ? m.settings_reading_loading_text()
                  : readFailed
                    ? readText
                    : uncertain
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
              {uncertain && (readLoading || readFailed) ? <p>{m.settings_reading_uncertain_text()}</p> : null}
              {uncertain && !readFailed && state.reason === 'closed' ? <p>{m.settings_closed_text()}</p> : null}
              {uncertain && !readFailed && state.reason === 'preparing' ? <p>{m.settings_preparing_text()}</p> : null}
              {uncertain && !readFailed && state.reason === 'unavailable' ? (
                <p>{m.settings_unavailable_text()}</p>
              ) : null}
              {waiting ? <p>{m.settings_retry_wait()}</p> : null}
              <p>
                {(state.knownCurrent ? m.settings_reading_current : m.settings_reading_known)({
                  spoilers: levels[state.known.spoilerLevel]!.title(),
                  images: state.known.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
                })}
              </p>
              <div className="flex min-w-0 flex-wrap gap-2">
                {uncertain ? (
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    variant="outline"
                    disabled={waiting || busy || !mayWrite}
                    onClick={() => void editor.retry(waiting)}
                  >
                    {m.settings_reading_retry_original()}
                  </Button>
                ) : null}
                <Button
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={waiting || busy}
                  onClick={() => void editor.reload(waiting)}
                >
                  {m.settings_reload()}
                </Button>
                {state.phase === 'review' ? (
                  <>
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      disabled={!mayWrite || sameReading(state.known, state.draft)}
                      onClick={() => void editor.submit()}
                    >
                      {m.settings_reading_save_draft()}
                    </Button>
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      variant="outline"
                      onClick={() => editor.useCurrent()}
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
