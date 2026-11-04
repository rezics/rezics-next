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
import { preferenceRetryDeadline, usePreferenceRetry } from './preference-failure-retry';
import { readingNeedsNavigationDecision, useSettingsNavigationDraft } from './reading-navigation';
import {
  ownerMayChangeReading,
  readingAdviceReady,
  readingChangeAdmitted,
  readingDefaults,
  readingMutation,
  readingReset,
  readReading,
  rebaseReading,
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
  confirmedReceipt: ReadingPreferences | null;
  phase: 'idle' | 'saving' | 'saved' | 'uncertain' | 'conflict' | 'reloading' | 'review' | 'failed';
  knownCurrent: boolean;
  advice?: ReadingAdvice | undefined;
  failureOrigin?: 'read' | 'write' | undefined;
  reason?: string | undefined;
  failure?: NativePreferenceFailure | undefined;
  readRetryAt: number;
  commandRetryAt: number;
};

function withoutReadingAdvice(preferences: ReadingPreferences): ReadingPreferences {
  const current = { ...preferences };
  delete current.advice;
  return current;
}

/** Reading keeps the editable draft separate from both confirmed values and an immutable original write. */
export class ReadingDraftRecovery {
  private state: ReadingState;
  private listeners = new Set<() => void>();
  // Value comparisons alone cannot distinguish a later edit back to an earlier value.
  private laterEdits: Partial<ReadingValues> = {};
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
    const advice = readingAdviceReady(initial.advice) ? initial.advice : undefined;
    this.state = {
      known: advice ? initial : withoutReadingAdvice(initial),
      draft: initial,
      pending: null,
      confirmedReceipt: null,
      phase: 'idle',
      knownCurrent: advice !== undefined,
      advice,
      readRetryAt: 0,
      commandRetryAt: 0,
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
  private canWrite() {
    return readingAdviceReady(this.state.advice) && ownerMayChangeReading(this.state.advice) && this.owner.canWrite();
  }
  private readWaiting() {
    return this.state.readRetryAt > Date.now();
  }
  private commandWaiting() {
    return this.state.commandRetryAt > Date.now();
  }
  private afterDispatch() {
    return this.state.pending !== null || this.state.confirmedReceipt !== null || this.state.phase === 'saving';
  }
  private adoptDraft(current: ReadingValues, base: ReadingValues): ReadingValues {
    const merged = rebaseReading(base, this.state.draft, current);
    return {
      spoilerLevel: this.laterEdits.spoilerLevel !== undefined ? this.laterEdits.spoilerLevel : merged.spoilerLevel,
      suitability: this.laterEdits.suitability !== undefined ? this.laterEdits.suitability : merged.suitability,
    };
  }
  private async send(recovering: boolean) {
    const input = this.state.pending;
    if (!input || !this.canWrite() || this.commandWaiting()) return;
    if (!recovering && !readingChangeAdmitted(input, this.state.advice!.reading.supported)) {
      this.update({
        pending: null,
        phase: 'review',
        reason: undefined,
        failure: undefined,
        failureOrigin: undefined,
      });
      return;
    }
    this.update({
      phase: 'saving',
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
      knownCurrent: false,
      confirmedReceipt: null,
    });
    const result = await sendReading(this.io, input, recovering, () => this.owner.version());
    if (!this.owner.canWrite()) return;
    if (result.kind === 'confirmed-read-failed') {
      const retireAdvice = result.reason === 'forbidden' || result.reason === 'closed';
      this.update({
        known: retireAdvice ? withoutReadingAdvice(this.state.known) : this.state.known,
        advice: retireAdvice ? undefined : this.state.advice,
        pending: null,
        confirmedReceipt: withoutReadingAdvice(result.receipt),
        phase: 'failed',
        knownCurrent: false,
        reason: result.reason,
        failure: result.failure,
        failureOrigin: 'read',
        readRetryAt: preferenceRetryDeadline(result.failure?.retryAfter),
        commandRetryAt: 0,
      });
      this.owner.onVersionChange(Math.max(this.owner.version(), result.receipt.version));
      return;
    }
    if (result.kind !== 'confirmed') {
      const retireAdvice = result.reason === 'forbidden' || result.reason === 'closed';
      const deniedWrite = result.kind === 'rejected' && retireAdvice;
      const readOperation = result.kind === 'uncertain' && result.operation === 'read';
      const retryAt = preferenceRetryDeadline(result.failure?.retryAfter);
      this.update({
        known: retireAdvice ? withoutReadingAdvice(this.state.known) : this.state.known,
        advice: retireAdvice ? undefined : this.state.advice,
        pending: result.kind === 'uncertain' ? input : null,
        phase: result.kind === 'uncertain' ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        failure: result.failure,
        failureOrigin: result.kind === 'uncertain' ? result.operation : deniedWrite ? 'write' : undefined,
        ...(readOperation ? { readRetryAt: retryAt } : { commandRetryAt: retryAt }),
      });
      return;
    }
    const { preferences, receipt } = result;
    const draft = this.adoptDraft(preferences, receipt);
    this.laterEdits = {};
    this.update({
      known: preferences,
      draft,
      knownCurrent: true,
      pending: null,
      confirmedReceipt: withoutReadingAdvice(receipt),
      phase: sameReading(draft, preferences) ? 'saved' : 'review',
      failure: undefined,
      advice: preferences.advice,
      commandRetryAt: 0,
      readRetryAt: recovering ? 0 : this.state.readRetryAt,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), preferences.version));
  }
  async submit() {
    if (
      !this.canWrite() ||
      !this.state.knownCurrent ||
      this.commandWaiting() ||
      this.state.pending ||
      this.state.phase === 'reloading'
    )
      return;
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
    this.laterEdits = {};
    this.update({ pending: input });
    await this.send(false);
  }
  async edit(next: Partial<ReadingValues>) {
    if (!this.canWrite()) return;
    const supported = this.state.advice?.reading.supported;
    if (next.spoilerLevel !== undefined && supported && !supported.spoilerLevels.includes(next.spoilerLevel)) return;
    if (next.suitability !== undefined && supported && !supported.suitability.includes(next.suitability)) return;
    if (this.afterDispatch()) this.laterEdits = { ...this.laterEdits, ...next };
    const autosave = this.state.phase === 'idle' || this.state.phase === 'saved';
    this.update({ draft: { ...this.state.draft, ...next } });
    if (autosave && !this.state.pending) await this.submit();
  }
  async resetToNativeDefaults() {
    if (
      !this.canWrite() ||
      !this.state.knownCurrent ||
      this.commandWaiting() ||
      this.state.pending ||
      this.state.phase === 'reloading'
    )
      return;
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
    const defaults = readingDefaults(this.state.advice);
    const input = readingReset(this.state.known);
    if (!input || !defaults) {
      this.laterEdits = {};
      this.update({ phase: 'idle', draft: this.state.known });
      return;
    }
    this.laterEdits = {};
    this.update({ draft: defaults, pending: input });
    await this.send(false);
  }
  async reload(_waiting?: boolean) {
    if (
      !this.owner.canRead() ||
      this.readWaiting() ||
      this.state.phase === 'saving' ||
      this.state.phase === 'reloading'
    )
      return;
    const adoptReceipt = this.state.confirmedReceipt !== null && !this.state.knownCurrent && this.state.pending === null;
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
      const retireAdvice = result.reason === 'forbidden' || result.reason === 'closed';
      this.update({
        known: retireAdvice ? withoutReadingAdvice(this.state.known) : this.state.known,
        advice: retireAdvice ? undefined : this.state.advice,
        phase: this.state.pending ? 'uncertain' : 'failed',
        reason: result.reason,
        failure: result.failure,
        failureOrigin: 'read',
        readRetryAt: preferenceRetryDeadline(result.failure?.retryAfter),
      });
      return;
    }
    if (
      this.state.confirmedReceipt &&
      result.preferences.version === this.state.confirmedReceipt.version &&
      !sameReading(result.preferences, this.state.confirmedReceipt)
    ) {
      this.update({
        phase: 'failed',
        knownCurrent: false,
        reason: 'unavailable',
        failure: undefined,
        failureOrigin: 'read',
        readRetryAt: 0,
      });
      return;
    }
    const pending = this.state.pending;
    const receipt = this.state.confirmedReceipt;
    const base = pending ? this.state.known : adoptReceipt && receipt ? receipt : this.state.known;
    const draft = this.adoptDraft(result.preferences, base);
    if (!pending) this.laterEdits = {};
    this.update({
      known: result.preferences,
      draft,
      knownCurrent: true,
      phase: pending
        ? 'uncertain'
        : sameReading(draft, result.preferences)
          ? adoptReceipt
            ? 'saved'
            : 'idle'
          : 'review',
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
      advice: result.preferences.advice,
      readRetryAt: 0,
    });
    this.owner.onVersionChange(Math.max(this.owner.version(), result.preferences.version));
  }
  useCurrent() {
    if (!this.owner.canRead() || this.state.pending || this.state.phase !== 'review' || !this.state.knownCurrent)
      return;
    // Discard is deliberate and local; it cannot settle an unresolved original or submit a write.
    this.laterEdits = {};
    this.update({
      draft: this.state.known,
      phase: 'idle',
      failure: undefined,
      reason: undefined,
      failureOrigin: undefined,
    });
  }
  async retry(_waiting?: boolean) {
    if (this.readWaiting() || this.commandWaiting() || !this.canWrite() || this.state.phase !== 'uncertain') return;
    await this.send(true);
  }
}

function readingLabel(values: ReadingValues) {
  return {
    spoilers: levels[values.spoilerLevel]!.title(),
    images: suitabilityLabel(values.suitability),
  };
}

function suitabilityLabel(value: ReadingValues['suitability']) {
  return value === 'blur' ? m.settings_reading_blur() : m.settings_reading_show();
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
          canWrite: () => mounted() && latest.current.credentialed && latest.current.isCurrent(),
          canRead: () => mounted() && latest.current.readCurrent(),
          version: () => sharedVersion.current,
          onVersionChange: (next) => latest.current.onVersionChange(next),
        },
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const adviceReady = readingAdviceReady(state.advice);
  const defaults = readingDefaults(state.advice);
  const ownerMayChange = adviceReady && ownerMayChangeReading(state.advice);
  const mayWrite = credentialed && ownerMayChange;
  const offered = adviceReady ? state.advice!.reading.supported.spoilerLevels : [];
  const offeredImages = adviceReady ? state.advice!.reading.supported.suitability : [];
  const draftMutation = readingMutation(state.known, state.draft);
  const draftAdmitted =
    !draftMutation || (adviceReady && readingChangeAdmitted(draftMutation, state.advice!.reading.supported));
  const retainedChoices = adviceReady
    ? [
        ...(!offered.includes(state.draft.spoilerLevel) ? [levels[state.draft.spoilerLevel]!.title()] : []),
        ...(!offeredImages.includes(state.draft.suitability) ? [suitabilityLabel(state.draft.suitability)] : []),
      ]
    : [];
  const suitabilityToggleOffered = offeredImages.includes('blur') && offeredImages.includes('show');
  const choicesReady = defaults !== undefined && offered.length > 0 && offeredImages.length > 0;
  useSettingsNavigationDraft(
    'reading',
    readingNeedsNavigationDecision(state),
    () => mounted() && isCurrent() && readingNeedsNavigationDecision(editor.snapshot()),
  );
  const readWaiting = usePreferenceRetry(state.failure, state.readRetryAt);
  const commandWaiting = usePreferenceRetry(state.failure, state.commandRetryAt);
  const waiting = readWaiting || commandWaiting;
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const uncertain = state.pending !== null && state.phase !== 'saving';
  const readLoading = state.phase === 'reloading';
  const readFailed = state.failureOrigin === 'read';
  const writeDenied = state.failureOrigin === 'write' && state.reason === 'forbidden';
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
      : writeDenied
        ? m.settings_reading_read_only_title()
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
              {suitabilityToggleOffered ? (
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
              ) : (
                <FieldSet aria-describedby={`${ids}-suitability-text ${ids}-suitability-availability`}>
                  <FieldLegend id={`${ids}-suitability-title`}>{m.settings_suitability_title()}</FieldLegend>
                  <FieldDescription id={`${ids}-suitability-text`}>{m.settings_suitability_text()}</FieldDescription>
                  <p id={`${ids}-suitability-availability`} className="text-sm text-muted-foreground">
                    {m.settings_reading_suitability_single({ choice: suitabilityLabel(offeredImages[0]!) })}
                  </p>
                </FieldSet>
              )}
            </FieldGroup>
            {retainedChoices.map((choice, index) => (
              <p key={`${index}:${choice}`} className="text-sm text-muted-foreground">
                {m.settings_reading_retained_choice({ choice })}
              </p>
            ))}
            {state.knownCurrent && defaults ? (
              <p className="text-sm text-muted-foreground">
                {m.settings_reading_effective({
                  ...readingLabel(state.advice!.reading.effective),
                  defaultSpoilers: levels[defaults.spoilerLevel]!.title(),
                  defaultImages:
                    defaults.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
                })}
              </p>
            ) : null}
            <ReadingPreview ids={ids} draft={state.draft} confirmed={state.known} />
            {ownerMayChange && defaults && !recovery && !sameReading(state.known, defaults) ? (
              <Button
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={busy || !mayWrite || commandWaiting}
                onClick={() => void editor.resetToNativeDefaults()}
              >
                {m.settings_reading_reset()}
              </Button>
            ) : null}
          </>
        ) : !recovery ? (
          <Alert>
            <AlertTitle>{m.settings_reading_choices_unavailable_title()}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>{m.settings_reading_choices_unavailable_text()}</p>
              <Button
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={readWaiting || busy}
                onClick={() => void editor.reload()}
              >
                {m.settings_reload()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
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
        {waiting && !recovery ? <p role="status">{m.settings_retry_wait()}</p> : null}
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
                    : writeDenied
                      ? m.settings_reading_read_only_text()
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
              {state.confirmedReceipt ? <p>{m.settings_saved()}</p> : null}
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
                    onClick={() => void editor.retry()}
                  >
                    {m.settings_reading_retry_original()}
                  </Button>
                ) : null}
                <Button
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={readWaiting || busy}
                  onClick={() => void editor.reload()}
                >
                  {m.settings_reload()}
                </Button>
                {state.phase === 'review' ? (
                  <>
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      disabled={!mayWrite || commandWaiting || sameReading(state.known, state.draft) || !draftAdmitted}
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
