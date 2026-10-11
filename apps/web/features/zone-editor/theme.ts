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
  | 'unavailable';

export interface ThemeEditorState {
  expectedHead: string;
  configuration: Record<string, unknown>;
  presentation: ZonePresentationBaseline;
  saved: StructuralThemeChoice;
  choice: StructuralThemeChoice;
  notice: ThemeNotice;
  needsReview: boolean;
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

/** Mirror the public configuration merge after a successful save; opaque fields stay intact. */
export function applyZoneThemePatch(
  configuration: Record<string, unknown>,
  patch: ThemeConfigurationPatch,
): Record<string, unknown> {
  return { ...configuration, ...patch };
}

export function initialThemeState(configuration: unknown, expectedHead: string): ThemeEditorStart {
  if (!isRecord(configuration)) return { kind: 'invalid' };
  const current = readPresentation(configuration);
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
    },
  };
}

export type ThemeEditorEvent =
  | { type: 'edit'; choice: StructuralThemeChoice }
  | { type: 'saved'; choice: StructuralThemeChoice; presentation: ZonePresentationBaseline; revision: string; replayed: boolean }
  | { type: 'stale' }
  | { type: 'failed'; failure: Exclude<ThemeNotice, 'idle' | 'saved' | 'replayed' | 'stale' | 'reviewed'> }
  | { type: 'reviewed'; configuration: unknown; revision: string }
  | { type: 'review-failed'; failure: 'denied' | 'sign-in' | 'unavailable' };

export function reduceThemeEditor(state: ThemeEditorState, event: ThemeEditorEvent): ThemeEditorState {
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
    };
  }
  if (event.type === 'stale') return { ...state, notice: 'stale', needsReview: true };
  if (event.type === 'failed') return { ...state, notice: event.failure };
  if (event.type === 'review-failed') return { ...state, notice: event.failure };

  const reviewed = initialThemeState(event.configuration, event.revision);
  if (reviewed.kind !== 'ready') return { ...state, notice: 'unavailable' };
  return {
    ...state,
    expectedHead: reviewed.state.expectedHead,
    configuration: reviewed.state.configuration,
    presentation: reviewed.state.presentation,
    saved: reviewed.state.saved,
    // Rebase only the baseline. The author’s two choices stay in the controls.
    choice: { ...state.choice },
    notice: 'reviewed',
    needsReview: false,
  };
}

export function isThemeDirty(state: ThemeEditorState): boolean {
  return state.choice.density !== state.saved.density || state.choice.pageSurface !== state.saved.pageSurface;
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
