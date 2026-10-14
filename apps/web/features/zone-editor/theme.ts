import type { MainClient } from '../manage/types.ts';

export type ZoneDensity = 'compact' | 'comfortable';
export type ZonePageSurface = 'flat' | 'cards';

export interface StructuralThemeChoice {
  density: ZoneDensity;
  pageSurface: ZonePageSurface;
}

type ZoneConfigurationEndpoint = ReturnType<MainClient['v1']['zones']>;
type ZoneConfigurationPutBody = NonNullable<Parameters<ZoneConfigurationEndpoint['configuration']['put']>[0]>;
export type ZonePresentationBaseline = NonNullable<ZoneConfigurationPutBody['presentation']>;

export type PresentationRead =
  | { kind: 'ready'; presentation: ZonePresentationBaseline; choice: StructuralThemeChoice }
  | { kind: 'absent' | 'legacy' | 'invalid' };

export type ThemeNotice =
  | 'idle'
  | 'saved'
  | 'replayed'
  | 'stale'
  | 'reviewed'
  | 'denied'
  | 'sign-in'
  | 'invalid-save'
  | 'conflict'
  | 'pending' | 'unavailable';

export interface ThemeEditorState {
  expectedHead: string;
  configuration: Record<string, unknown>;
  presentation: ZonePresentationBaseline;
  saved: StructuralThemeChoice;
  choice: StructuralThemeChoice;
  notice: ThemeNotice;
  needsReview: boolean;
  initialization: 'offered' | 'draft' | 'saved';
}

export interface EffectiveZonePresentation {
  revision: string;
  presentation: ZonePresentationBaseline;
}

export type ThemeEditorStart =
  | { kind: 'ready'; state: ThemeEditorState }
  | { kind: 'absent' | 'legacy' | 'invalid' };

export type ThemeConfigurationPatch = { presentation: ZonePresentationBaseline };

export function readPresentation(configuration: unknown): PresentationRead {
  if (!isRecord(configuration)) return { kind: 'invalid' };
  const value = configuration.presentation;
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value === 'string') return { kind: 'legacy' };
  if (!isRecord(value)) return { kind: 'invalid' };
  if (value.profile === 'zone-presentation-v1') return { kind: 'legacy' };
  if (value.profile !== 'zone-presentation-v2' || !isRecord(value.tokens)) return { kind: 'invalid' };

  const density = value.tokens.density;
  const pageSurface = value.tokens.pageSurface;
  if (!isDensity(density) || !isPageSurface(pageSurface)) return { kind: 'invalid' };
  return {
    kind: 'ready',
    presentation: value as ZonePresentationBaseline,
    choice: { density, pageSurface },
  };
}

/** Build the one-field public configuration patch from the full saved baseline. */
export function zoneThemePatch(
  configuration: unknown,
  choice: StructuralThemeChoice,
): ThemeConfigurationPatch | null {
  const current = readPresentation(configuration);
  if (current.kind !== 'ready') return null;
  const presentation = structuredClone(current.presentation);
  presentation.tokens = { ...presentation.tokens, density: choice.density, pageSurface: choice.pageSurface };
  return { presentation };
}

/** Only an explicit creation may replace an absent presentation with authorized defaults. */
export function createZoneThemePatch(
  configuration: unknown,
  defaults: ZonePresentationBaseline,
  choice: StructuralThemeChoice,
): ThemeConfigurationPatch | null {
  if (readPresentation(configuration).kind !== 'absent') return null;
  return zoneThemePatch({ presentation: defaults }, choice);
}

/** Mirror the public configuration merge after a successful save; opaque fields stay intact. */
export function applyZoneThemePatch(
  configuration: Record<string, unknown>,
  patch: ThemeConfigurationPatch,
): Record<string, unknown> {
  return { ...configuration, ...patch };
}

export function initialThemeState(configuration: unknown, expectedHead: string,
  effective?: EffectiveZonePresentation,
): ThemeEditorStart {
  if (!isRecord(configuration)) return { kind: 'invalid' };
  let current = readPresentation(configuration);
  const absent = current.kind === 'absent';
  if (absent && effective) {
    if (effective.revision !== expectedHead) return { kind: 'invalid' };
    current = readPresentation({ presentation: effective.presentation });
    if (current.kind !== 'ready') return { kind: 'invalid' };
  }
  if (current.kind !== 'ready') return current;
  const baseline = structuredClone(current.presentation);
  const choice = { ...current.choice };
  return {
    kind: 'ready',
    state: {
      expectedHead,
      configuration: structuredClone(configuration),
      presentation: baseline,
      saved: choice,
      choice: { ...choice },
      notice: 'idle',
      needsReview: false,
      initialization: absent ? 'offered' : 'saved',
    },
  };
}

export type ThemeEditorEvent =
  | { type: 'create' }
  | { type: 'edit'; choice: StructuralThemeChoice }
  | { type: 'saved'; choice: StructuralThemeChoice; presentation: ZonePresentationBaseline; revision: string; replayed: boolean }
  | { type: 'stale' }
  | { type: 'failed'; failure: Exclude<ThemeNotice, 'idle' | 'saved' | 'replayed' | 'stale' | 'reviewed'> }
  | { type: 'reviewed'; configuration: unknown; revision: string; effectivePresentation?: EffectiveZonePresentation }
  | { type: 'review-failed'; failure: 'denied' | 'sign-in' | 'unavailable' };

export function reduceThemeEditor(state: ThemeEditorState, event: ThemeEditorEvent): ThemeEditorState {
  if (event.type === 'create') return state.initialization === 'offered'
    ? { ...state, initialization: 'draft', notice: 'idle' } : state;
  if (event.type === 'edit') return { ...state, choice: { ...event.choice }, notice: state.needsReview ? 'stale' : 'idle' };
  if (event.type === 'saved') {
    const patch = { presentation: event.presentation };
    return {
      ...state,
      expectedHead: event.revision,
      configuration: applyZoneThemePatch(state.configuration, patch),
      presentation: event.presentation,
      saved: { ...event.choice },
      choice: { ...state.choice },
      notice: event.replayed ? 'replayed' : 'saved',
      needsReview: false,
      initialization: 'saved',
    };
  }
  if (event.type === 'stale') return { ...state, notice: 'stale', needsReview: true };
  if (event.type === 'failed') return { ...state, notice: event.failure };
  if (event.type === 'review-failed') return { ...state, notice: event.failure };

  const reviewed = initialThemeState(event.configuration, event.revision, event.effectivePresentation);
  if (reviewed.kind !== 'ready') return { ...state, notice: 'unavailable' };
  return {
    ...state,
    expectedHead: reviewed.state.expectedHead,
    configuration: reviewed.state.configuration,
    presentation: reviewed.state.presentation,
    saved: reviewed.state.saved,
    initialization: reviewed.state.initialization === 'offered' && state.initialization === 'draft'
      ? 'draft' : reviewed.state.initialization,
    // Rebase only the baseline. The author’s two choices stay in the controls.
    choice: { ...state.choice },
    notice: 'reviewed',
    needsReview: false,
  };
}

export function isThemeDirty(state: ThemeEditorState): boolean {
  return state.initialization === 'draft'
    || state.choice.density !== state.saved.density || state.choice.pageSurface !== state.saved.pageSurface;
}

function isDensity(value: unknown): value is ZoneDensity {
  return value === 'compact' || value === 'comfortable';
}

function isPageSurface(value: unknown): value is ZonePageSurface {
  return value === 'flat' || value === 'cards';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
