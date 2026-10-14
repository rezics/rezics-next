'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { cn } from '@rezics/ui/utils';
import { useRef } from 'react';
import type { WriteRound } from '../api/command.ts';
import { zoneCommandLane as commandLane } from './api.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { reopenAuthoringNotice } from './draft-state.ts';
import { useZoneEditorDraft, useZoneEditorExitActions, useZoneEditorResource, useZoneEditorRef, useZoneEditorSessionState } from './draft-provider.tsx';
import {
  browserZoneTheme,
  commitCommand,
  type SavedZoneTheme,
  type WriteResult,
  type ZoneThemeClient,
} from './api.ts';
import type { ZoneEditorMessages } from './messages.ts';
import {
  createZoneThemePatch,
  isThemeDirty,
  reduceThemeEditor,
  zoneThemePatch,
  type StructuralThemeChoice,
  type ThemeEditorState,
  type ThemeEditorStart,
  type ThemeNotice,
  type ZonePresentationBaseline,
} from './theme.ts';

const actionClass = 'h-auto min-h-9 whitespace-normal px-3';

interface ThemeSaveIntent {
  expectedHead: string;
  choice: StructuralThemeChoice;
  presentation: ZonePresentationBaseline;
}

/** Edit the Zone's two structural tokens without replacing its saved presentation. */
export function ZoneThemeEditor({ zoneId, actingSubject, copy, initial, signInHref, previewHref, siteHref, shellPresentation, api }: {
  zoneId: string;
  actingSubject: string;
  copy: ZoneEditorMessages;
  initial: ThemeEditorStart;
  signInHref: string;
  previewHref?: string;
  siteHref?: string;
  shellPresentation?: ZonePresentationBaseline;
  api?: ZoneThemeClient;
}) {
  if (initial.kind !== 'ready') return <ThemeUnavailable kind={initial.kind} copy={copy} />;
  return <EditableThemeEditor zoneId={zoneId} actingSubject={actingSubject} copy={copy}
    initial={initial.state} signInHref={signInHref} previewHref={previewHref} siteHref={siteHref}
    shellPresentation={shellPresentation} api={api} />;
}

function EditableThemeEditor({ zoneId, actingSubject, copy, initial, signInHref, previewHref, siteHref, shellPresentation, api }: {
  zoneId: string;
  actingSubject: string;
  copy: ZoneEditorMessages;
  initial: ThemeEditorState;
  signInHref: string;
  previewHref?: string;
  siteHref?: string;
  shellPresentation?: ZonePresentationBaseline;
  api?: ZoneThemeClient;
}) {
  const [state, setState, draftReady] = useZoneEditorDraft('theme', initial, isThemeDirty, isThemeEditorState, reopenAuthoringNotice);
  const [busy, updateBusy] = useZoneEditorSessionState<null | 'save' | 'review'>('theme-busy', null);
  const busyRef = useZoneEditorRef('theme-busy-ref', busy);
  busyRef.current = busy;
  const stateRef = useZoneEditorRef('theme-state', state);
  stateRef.current = state;
  const captured = useZoneEditorRef<ThemeSaveIntent | null>('theme-choice', null);
  const client = useRef<ZoneThemeClient | null>(null);
  const saveLane = useZoneEditorResource('theme:save',
    () => commandLane<ThemeSaveIntent, WriteResult<SavedZoneTheme>>({ ok: false, failure: 'unavailable' }));
  if (!client.current) client.current = api ?? browserZoneTheme(undefined, shellPresentation);
  useZoneEditorExitActions('theme', async () => {
    if (busyRef.current || stateRef.current.needsReview) return false;
    const choice = captured.current ?? intentFor(stateRef.current);
    if (!choice) return false;
    captured.current = choice;
    setBusy('save');
    try {
      const result = await saveLane.submit(choice, applySave);
      return result.ok && !isThemeDirty(stateRef.current);
    } finally {
      setBusy(null);
    }
  }, () => {
    captured.current = null;
    setState(current => {
      const next: ThemeEditorState = { ...current, choice: current.saved,
        initialization: current.initialization === 'draft' ? 'offered' : current.initialization, notice: 'idle' };
      stateRef.current = next;
      return next;
    });
  }, () => captured.current !== null);

  function setBusy(next: typeof busy) {
    busyRef.current = next;
    updateBusy(next);
  }

  function put(event: Parameters<typeof reduceThemeEditor>[1]) {
    setState(current => {
      const next = reduceThemeEditor(current, event);
      stateRef.current = next;
      return next;
    });
  }

  function intentFor(current: ThemeEditorState): ThemeSaveIntent | null {
    const patch = current.initialization === 'draft'
      ? createZoneThemePatch(current.configuration, current.presentation, current.choice)
      : zoneThemePatch(current.configuration, current.choice);
    return patch ? { expectedHead: current.expectedHead, choice: { ...current.choice }, presentation: patch.presentation } : null;
  }

  function applySave(chosen: ThemeSaveIntent, round: WriteRound) {
    return commitCommand(round, key => client.current!.saveConfiguration(zoneId, {
      expectedHead: chosen.expectedHead,
      actingSubject,
      presentation: chosen.presentation,
    }, key)).then(result => {
      if (result.ok) put({ type: 'saved', choice: chosen.choice, presentation: chosen.presentation,
        revision: result.data.revision, replayed: result.data.replayed });
      else if (result.failure === 'stale') put({ type: 'stale' });
      else put({ type: 'failed', failure: noticeFailure(result.failure) });
      if (result.ok || !saveLane.needsConfirmation(result)) captured.current = null;
      return result;
    });
  }

  async function save() {
    if (busyRef.current || !draftReady || stateRef.current.needsReview
      || (!isThemeDirty(stateRef.current) && !captured.current)) return;
    const choice = captured.current ?? intentFor(stateRef.current);
    if (!choice) return;
    captured.current = choice;
    setBusy('save');
    try {
      await saveLane.submit(choice, applySave);
    } finally {
      setBusy(null);
    }
  }

  async function reviewLatest() {
    if (busyRef.current || !draftReady || !stateRef.current.needsReview) return;
    setBusy('review');
    try {
      const current = await client.current!.readConfiguration(zoneId, actingSubject);
      if (current.ok) put({ type: 'reviewed', configuration: current.data.configuration, revision: current.data.revision,
        effectivePresentation: current.data.effectivePresentation });
      else put({ type: 'review-failed', failure: reviewFailure(current.failure) });
    } catch {
      put({ type: 'review-failed', failure: 'unavailable' });
    } finally {
      setBusy(null);
    }
  }

  const authorityRefused = state.notice === 'denied' || state.notice === 'sign-in';
  const dirty = isThemeDirty(state) || captured.current !== null;
  if (state.initialization === 'offered') return <section className="grid min-w-0 max-w-3xl gap-3" aria-labelledby="zone-theme-title">
    <h2 id="zone-theme-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.themeTitle}</h2>
    <Alert variant="info" role="status">
      <AlertTitle>{copy.themeAbsentTitle}</AlertTitle>
      <AlertDescription>{copy.themeDefaultsBody}</AlertDescription>
    </Alert>
    <Button variant="secondary" size="sm" className="justify-self-start" disabled={authorityRefused || !draftReady}
      onClick={() => put({ type: 'create' })}>{copy.themeCreate}</Button>
  </section>;
  return <section className="grid min-w-0 max-w-3xl gap-5" aria-labelledby="zone-theme-title">
    <header className="grid min-w-0 gap-2">
      <h2 id="zone-theme-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.themeTitle}</h2>
      <p className="text-pretty text-muted-foreground text-sm">{copy.themeHelp}</p>
    </header>
    <ThemeNotice state={state} copy={copy} signInHref={signInHref} busy={busy}
      onReview={() => { void reviewLatest(); }} />
    <div className="grid min-w-0 gap-5 sm:grid-cols-2">
      <RadioGroup name="zone-density" value={state.choice.density} disabled={authorityRefused || !draftReady || busy !== null}
        onValueChange={({ value }) => {
          if (value === 'compact' || value === 'comfortable') put({ type: 'edit', choice: { ...state.choice, density: value } });
        }}>
        <RadioGroupLabel className="font-medium">{copy.themeDensity}</RadioGroupLabel>
        <RadioGroupItem value="comfortable" className="rounded-xl border border-border/70 p-3">
          <span>{copy.themeComfortable}</span>
        </RadioGroupItem>
        <RadioGroupItem value="compact" className="rounded-xl border border-border/70 p-3">
          <span>{copy.themeCompact}</span>
        </RadioGroupItem>
      </RadioGroup>
      <RadioGroup name="zone-page-surface" value={state.choice.pageSurface} disabled={authorityRefused || !draftReady || busy !== null}
        onValueChange={({ value }) => {
          if (value === 'flat' || value === 'cards') put({ type: 'edit', choice: { ...state.choice, pageSurface: value } });
        }}>
        <RadioGroupLabel className="font-medium">{copy.themePageSurface}</RadioGroupLabel>
        <RadioGroupItem value="flat" className="rounded-xl border border-border/70 p-3">
          <span>{copy.themeFlat}</span>
        </RadioGroupItem>
        <RadioGroupItem value="cards" className="rounded-xl border border-border/70 p-3">
          <span>{copy.themeCards}</span>
        </RadioGroupItem>
      </RadioGroup>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" disabled={authorityRefused || !draftReady || !dirty || state.needsReview || busy !== null}
        isLoading={busy === 'save'} onClick={() => void save()}>
        {busy === 'save' ? copy.themeSaving : state.notice === 'pending' ? copy.checkConfirmation : copy.themeSave}
      </Button>
      {previewHref && !authorityRefused ? <LocalizedLink href={previewHref} documentNavigation
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), actionClass)}>{copy.preview}</LocalizedLink> : null}
      {siteHref ? <LocalizedLink href={siteHref} documentNavigation
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), actionClass)}>{copy.viewSite}</LocalizedLink> : null}
    </div>
  </section>;
}

function isThemeEditorState(value: unknown): value is ThemeEditorState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ThemeEditorState>;
  return typeof state.expectedHead === 'string' && !!state.choice && !!state.saved
    && !!state.presentation && !!state.configuration && typeof state.needsReview === 'boolean';
}

function ThemeNotice({ state, copy, signInHref, busy, onReview }: {
  state: ThemeEditorState;
  copy: ZoneEditorMessages;
  signInHref: string;
  busy: 'save' | 'review' | null;
  onReview: () => void;
}) {
  if (state.notice === 'pending') return <p role="status" className="text-sm">{copy.commandPending}</p>;
  if (state.notice === 'saved') return <p role="status" className="text-sm">{copy.themeSaved}</p>;
  if (state.notice === 'replayed') return <p role="status" className="text-sm">{copy.themeSavedReplayed}</p>;
  if (state.notice === 'reviewed') return <p role="status" className="text-sm">{copy.themeReviewed}</p>;
  if (state.notice === 'idle' && !state.needsReview) return null;

  const stale = state.notice === 'stale';
  const failure = failureCopy(copy, state.notice);
  return <Alert variant={stale ? 'warning' : state.notice === 'sign-in' ? 'info' : 'destructive'}
    role="alert" className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div className="min-w-0 space-y-1">
      <AlertTitle>{stale ? copy.themeStaleTitle : failure.title}</AlertTitle>
      <AlertDescription>{stale ? copy.themeStaleBody : failure.body}</AlertDescription>
    </div>
    {state.needsReview ? <Button variant="outline" size="sm" className={cn(actionClass, 'mt-3 sm:mt-0')}
      disabled={busy !== null} isLoading={busy === 'review'} onClick={onReview}>{copy.themeReviewLatest}</Button> : null}
    {state.notice === 'sign-in' ? <LocalizedLink href={signInHref}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), actionClass, 'mt-3 sm:mt-0')}>{copy.signInTitle}</LocalizedLink> : null}
  </Alert>;
}

function failureCopy(copy: ZoneEditorMessages, notice: ThemeNotice): { title: string; body: string } {
  switch (notice) {
    case 'denied': return { title: copy.deniedTitle, body: copy.themeDeniedBody };
    case 'sign-in': return { title: copy.signInTitle, body: copy.themeSignInBody };
    case 'invalid-save': return { title: copy.invalidTitle, body: copy.themeInvalidSaveBody };
    case 'conflict': return { title: copy.conflictTitle, body: copy.themeConflictBody };
    default: return { title: copy.unavailableTitle, body: copy.themeUnavailableBody };
  }
}

function noticeFailure(failure: string): 'denied' | 'sign-in' | 'invalid-save' | 'conflict' | 'pending' | 'unavailable' {
  switch (failure) {
    case 'pending': return 'pending';
    case 'denied': return 'denied';
    case 'sign-in': return 'sign-in';
    case 'invalid': return 'invalid-save';
    case 'conflict': return 'conflict';
    default: return 'unavailable';
  }
}

function reviewFailure(failure: string): 'denied' | 'sign-in' | 'unavailable' {
  if (failure === 'denied' || failure === 'sign-in') return failure;
  return 'unavailable';
}

function ThemeUnavailable({ kind, copy }: { kind: Exclude<ThemeEditorStart['kind'], 'ready'>; copy: ZoneEditorMessages }) {
  const text = kind === 'absent'
    ? [copy.themeAbsentTitle, copy.themeAbsentBody]
    : kind === 'legacy'
      ? [copy.themeLegacyTitle, copy.themeLegacyBody]
      : [copy.themeInvalidTitle, copy.themeInvalidBody];
  return <section className="grid min-w-0 max-w-3xl gap-3" aria-labelledby="zone-theme-title">
    <h2 id="zone-theme-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.themeTitle}</h2>
    <Alert variant={kind === 'invalid' ? 'destructive' : 'info'} role="status">
      <AlertTitle>{text[0]}</AlertTitle>
      <AlertDescription>{text[1]}</AlertDescription>
    </Alert>
  </section>;
}
