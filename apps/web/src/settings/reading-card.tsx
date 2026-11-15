import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
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
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import { usePreferenceRetry } from './preference-failure-retry';
import { preferenceRetryDeadline, type SettingsAmbient } from './ports/ambient';
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

const preferenceActionClassName = 'h-auto max-w-full whitespace-normal wrap-anywhere min-h-7';

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
    private ambient: SettingsAmbient,
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
    return this.state.readRetryAt > this.ambient.now();
  }
  private commandWaiting() {
    return this.state.commandRetryAt > this.ambient.now();
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
    const result = await sendReading(
      this.io,
      input,
      recovering,
      () => this.owner.version(),
      this.ambient.timer,
      () => !this.readWaiting(),
    );
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
        readRetryAt: Math.max(
          this.state.readRetryAt,
          preferenceRetryDeadline(result.failure?.retryAfter, this.ambient.now()),
        ),
        commandRetryAt: 0,
      });
      this.owner.onVersionChange(Math.max(this.owner.version(), result.receipt.version));
      return;
    }
    if (result.kind !== 'confirmed') {
      const retireAdvice = result.reason === 'forbidden' || result.reason === 'closed';
      const deniedWrite = result.kind === 'rejected' && retireAdvice;
      const readOperation = result.kind === 'uncertain' && result.operation === 'read';
      const retryAt = preferenceRetryDeadline(result.failure?.retryAfter, this.ambient.now());
      this.update({
        known: retireAdvice ? withoutReadingAdvice(this.state.known) : this.state.known,
        advice: retireAdvice ? undefined : this.state.advice,
        pending: result.kind === 'uncertain' ? input : null,
        phase: result.kind === 'uncertain' ? 'uncertain' : result.reason === 'conflict' ? 'conflict' : 'failed',
        reason: result.reason,
        failure: result.failure,
        failureOrigin: result.kind === 'uncertain' ? result.operation : deniedWrite ? 'write' : undefined,
        ...(readOperation ? { readRetryAt: Math.max(this.state.readRetryAt, retryAt) } : { commandRetryAt: retryAt }),
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
      readRetryAt: 0,
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
    const input = readingMutation(this.state.known, this.state.draft, this.ambient.id);
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
    const autosave = this.state.phase === 'idle' || this.state.phase === 'saved';
    if (this.afterDispatch() || !autosave) this.laterEdits = { ...this.laterEdits, ...next };
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
    const input = readingReset(this.state.known, this.ambient.id);
    if (!input || !defaults) return;
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
    const adoptReceipt =
      this.state.confirmedReceipt !== null && !this.state.knownCurrent && this.state.pending === null;
    this.update({
      phase: 'reloading',
      knownCurrent: false,
      reason: undefined,
      failure: undefined,
      failureOrigin: undefined,
    });
    const result = await readReading(
      this.io,
      () => Math.max(this.state.known.version, this.owner.version()),
      this.ambient.timer,
    );
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
        readRetryAt: Math.max(
          this.state.readRetryAt,
          preferenceRetryDeadline(result.failure?.retryAfter, this.ambient.now()),
        ),
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
    if (this.commandWaiting() || !this.canWrite() || this.state.phase !== 'uncertain') return;
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
    <figure
      className="min-w-0 max-w-full rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-labelledby={`${ids}-preview`}
    >
      <figcaption id={`${ids}-preview`} className="min-w-0 max-w-full text-base font-semibold wrap-anywhere">
        {m.settings_reading_preview_legend()}
      </figcaption>
      <p
        className={`mt-2 inline-flex max-w-full rounded-full px-2.5 py-1 text-sm font-medium wrap-anywhere ${
          draftPreview ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
        }`}
      >
        {draftPreview ? m.settings_reading_preview_draft() : m.settings_reading_preview_confirmed()}
      </p>
      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem] sm:items-start">
        <article className="min-w-0 rounded-lg border border-border/70 bg-background p-3 sm:p-4">
          <p className="min-w-0 max-w-full font-medium wrap-anywhere">{m.settings_reading_preview_title()}</p>
          <p className="mt-1 min-w-0 max-w-full text-sm text-muted-foreground wrap-anywhere">
            {m.settings_reading_preview_summary()}
          </p>
          <div className="mt-3 space-y-2">
            <p
              className="min-w-0 max-w-full rounded-md bg-muted/70 px-3 py-2 text-sm wrap-anywhere"
              data-spoiler="minor"
            >
              {values.spoilerLevel >= 1 ? m.settings_reading_preview_minor() : m.settings_reading_preview_hidden()}
            </p>
            <p
              className="min-w-0 max-w-full rounded-md bg-muted/70 px-3 py-2 text-sm wrap-anywhere"
              data-spoiler="major"
            >
              {values.spoilerLevel >= 2 ? m.settings_reading_preview_major() : m.settings_reading_preview_hidden()}
            </p>
          </div>
        </article>
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div
            className={`min-h-28 w-full max-w-full rounded-md bg-muted p-3 text-center text-sm wrap-anywhere ${
              values.suitability === 'blur' ? 'blur-sm' : ''
            }`}
            aria-hidden="true"
          >
            {m.settings_reading_preview_cover()}
          </div>
          <p className="sr-only">
            {values.suitability === 'blur' ? m.settings_reading_preview_cover_blur() : m.settings_reading_preview_cover()}
          </p>
        </div>
      </div>
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
  const ambient = useSettingsAmbient();
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
        ambient,
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const adviceReady = readingAdviceReady(state.advice);
  const defaults = readingDefaults(state.advice);
  const reset = state.knownCurrent ? readingReset(state.known, ambient.id) : null;
  const ownerMayChange = adviceReady && ownerMayChangeReading(state.advice);
  const mayWrite = credentialed && ownerMayChange;
  const offered = adviceReady ? state.advice!.reading.supported.spoilerLevels : [];
  const offeredImages = adviceReady ? state.advice!.reading.supported.suitability : [];
  const draftMutation = readingMutation(state.known, state.draft, ambient.id);
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
    <ContentSection className="min-w-0 max-w-full">
      <ContentSectionHeader>
        <ContentSectionTitle>
          <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription className="min-w-0 max-w-full wrap-anywhere">
          {m.settings_reading_text()}
        </ContentSectionDescription>
        {choicesReady ? (
          <ContentSectionDescription className="min-w-0 max-w-full wrap-anywhere">
            {ownerMayChange ? m.settings_automatic_save_help() : m.settings_reading_read_only_text()}
          </ContentSectionDescription>
        ) : null}
      </ContentSectionHeader>
      <ContentSectionBody className="min-w-0 space-y-5 sm:space-y-6">
        {choicesReady ? (
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(18rem,0.92fr)] lg:items-start lg:gap-6">
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
                <FieldGroup className="min-w-0 gap-6">
                  <FieldSet className="min-w-0">
                    <FieldLegend id={`${ids}-spoilers`} className="max-w-full wrap-anywhere">
                      {m.settings_spoiler_legend()}
                    </FieldLegend>
                    <FieldDescription className="min-w-0 max-w-full wrap-anywhere">
                      {m.settings_spoiler_text()}
                    </FieldDescription>
                    <RadioGroup
                      className="mt-3 grid min-w-0 gap-2"
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
                          <FieldLabel
                            key={level.value}
                            htmlFor={`${ids}-level-${level.value}`}
                            className="min-w-0 max-w-full rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
                          >
                            <Field orientation="horizontal" className="min-w-0 items-start gap-3">
                              <FieldContent className="min-w-0">
                                <FieldTitle
                                  id={`${ids}-level-${level.value}-title`}
                                  className="max-w-full wrap-anywhere"
                                >
                                  {level.title()}
                                </FieldTitle>
                                <FieldDescription
                                  id={`${ids}-level-${level.value}-text`}
                                  className="min-w-0 max-w-full wrap-anywhere"
                                >
                                  {level.text()}
                                </FieldDescription>
                              </FieldContent>
                              <RadioGroupItem
                                className="mt-1 shrink-0"
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
                    <FieldLabel
                      htmlFor={`${ids}-suitability`}
                      className="min-w-0 max-w-full rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
                    >
                      <Field orientation="horizontal" className="min-w-0 items-start gap-3">
                        <FieldContent className="min-w-0">
                          <FieldTitle id={`${ids}-suitability-title`} className="max-w-full wrap-anywhere">
                            {m.settings_suitability_title()}
                          </FieldTitle>
                          <FieldDescription
                            id={`${ids}-suitability-text`}
                            className="min-w-0 max-w-full wrap-anywhere"
                          >
                            {m.settings_suitability_text()}
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          className="mt-1 shrink-0"
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
                    <FieldSet
                      className="min-w-0 rounded-lg border border-border bg-background p-3"
                      aria-describedby={`${ids}-suitability-text ${ids}-suitability-availability`}
                    >
                      <FieldLegend id={`${ids}-suitability-title`} className="max-w-full wrap-anywhere">
                        {m.settings_suitability_title()}
                      </FieldLegend>
                      <FieldDescription
                        id={`${ids}-suitability-text`}
                        className="min-w-0 max-w-full wrap-anywhere"
                      >
                        {m.settings_suitability_text()}
                      </FieldDescription>
                      <p
                        id={`${ids}-suitability-availability`}
                        className="min-w-0 max-w-full text-sm text-muted-foreground wrap-anywhere"
                      >
                        {m.settings_reading_suitability_single({ choice: suitabilityLabel(offeredImages[0]!) })}
                      </p>
                    </FieldSet>
                  )}
                </FieldGroup>
              </div>
              <div className="min-w-0 space-y-2">
                {retainedChoices.map((choice, index) => (
                  <p
                    key={`${index}:${choice}`}
                    className="min-w-0 max-w-full text-sm text-muted-foreground wrap-anywhere"
                  >
                    {m.settings_reading_retained_choice({ choice })}
                  </p>
                ))}
                {state.knownCurrent && defaults ? (
                  <p className="min-w-0 max-w-full text-sm text-muted-foreground wrap-anywhere">
                    {m.settings_reading_effective({
                      ...readingLabel(state.advice!.reading.effective),
                      defaultSpoilers: levels[defaults.spoilerLevel]!.title(),
                      defaultImages:
                        defaults.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
                    })}
                  </p>
                ) : null}
              </div>
              {ownerMayChange && reset && !recovery ? (
                <Button
                  className={`${preferenceActionClassName} w-full sm:w-auto`}
                  type="button"
                  variant="outline"
                  disabled={busy || !mayWrite || commandWaiting}
                  onClick={() => void editor.resetToNativeDefaults()}
                >
                  {m.settings_reading_reset()}
                </Button>
              ) : null}
            </div>
            <ReadingPreview ids={ids} draft={state.draft} confirmed={state.known} />
          </div>
        ) : !recovery ? (
          <Alert className="min-w-0 max-w-full">
            <AlertTitle>{m.settings_reading_choices_unavailable_title()}</AlertTitle>
            <AlertDescription className="flex min-w-0 flex-col gap-3 wrap-anywhere">
              <p className="min-w-0 max-w-full">{m.settings_reading_choices_unavailable_text()}</p>
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
          <Alert className="min-w-0 max-w-full">
            <AlertTitle className="min-w-0 max-w-full wrap-anywhere">
              {m.settings_reading_read_only_title()}
            </AlertTitle>
            <AlertDescription className="min-w-0 max-w-full wrap-anywhere">
              {m.settings_reading_read_only_text()}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="min-w-0 space-y-3 border-t border-border pt-4 sm:pt-5">
          <div
            aria-live="polite"
            className={`min-h-5 min-w-0 max-w-full text-sm text-muted-foreground wrap-anywhere ${
              state.phase === 'saving' || state.phase === 'saved'
                ? 'rounded-md border border-border bg-muted/40 px-3 py-2'
                : ''
            }`}
          >
            {state.phase === 'saving' ? m.settings_saving() : null}
            {state.phase === 'saved' ? m.settings_saved() : null}
          </div>
          {waiting && !recovery ? (
            <p role="status" className="min-w-0 max-w-full text-sm wrap-anywhere">
              {m.settings_retry_wait()}
            </p>
          ) : null}
          {recovery ? (
            <Alert
              className="min-w-0 max-w-full"
              role={readLoading ? 'status' : 'alert'}
              data-response-status={state.failure?.status ?? ''}
              data-response-code={state.failure?.code ?? ''}
              data-retry-after={state.failure?.retryAfter}
            >
              <AlertTitle className="min-w-0 max-w-full wrap-anywhere">{title}</AlertTitle>
              <AlertDescription className="flex min-w-0 flex-col gap-3 wrap-anywhere">
                <p className="min-w-0 max-w-full">
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
                {state.confirmedReceipt ? <p className="min-w-0 max-w-full">{m.settings_saved()}</p> : null}
                {uncertain && (readLoading || readFailed) ? (
                  <p className="min-w-0 max-w-full">{m.settings_reading_uncertain_text()}</p>
                ) : null}
                {uncertain && !readFailed && state.reason === 'closed' ? (
                  <p className="min-w-0 max-w-full">{m.settings_closed_text()}</p>
                ) : null}
                {uncertain && !readFailed && state.reason === 'preparing' ? (
                  <p className="min-w-0 max-w-full">{m.settings_preparing_text()}</p>
                ) : null}
                {uncertain && !readFailed && state.reason === 'unavailable' ? (
                  <p className="min-w-0 max-w-full">{m.settings_unavailable_text()}</p>
                ) : null}
                {waiting ? <p className="min-w-0 max-w-full">{m.settings_retry_wait()}</p> : null}
                <p className="min-w-0 max-w-full wrap-anywhere">
                  {(state.knownCurrent ? m.settings_reading_current : m.settings_reading_known)({
                    spoilers: levels[state.known.spoilerLevel]!.title(),
                    images:
                      state.known.suitability === 'blur' ? m.settings_reading_blur() : m.settings_reading_show(),
                  })}
                </p>
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  {uncertain ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      variant="outline"
                      disabled={commandWaiting || busy || !mayWrite}
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
        </div>
      </ContentSectionBody>
    </ContentSection>
  );
}
