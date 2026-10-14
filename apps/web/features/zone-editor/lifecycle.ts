import type { ZoneLifecycleSnapshot, ZoneLifecycleStatus } from './api.ts';

export type ZoneLifecycleAction = 'retire' | 'recover';
export type ZoneLifecycleNotice = 'idle' | 'retired' | 'retired-replayed' | 'recovered' | 'recovered-replayed'
  | 'stale' | 'reviewed' | 'denied' | 'sign-in' | 'invalid' | 'conflict' | 'pending' | 'unavailable';

export interface ZoneLifecycleEditorState {
  expectedHead: string;
  status: ZoneLifecycleStatus;
  selection: ZoneLifecycleAction | null;
  notice: ZoneLifecycleNotice;
  needsReview: boolean;
}

export type ZoneLifecycleEvent =
  | { type: 'select'; action: ZoneLifecycleAction }
  | { type: 'cancel' }
  | { type: 'stale' }
  | { type: 'saved'; action: ZoneLifecycleAction; snapshot: ZoneLifecycleSnapshot; replayed: boolean }
  | { type: 'failed'; failure: Exclude<ZoneLifecycleNotice,
      'idle' | 'retired' | 'retired-replayed' | 'recovered' | 'recovered-replayed' | 'stale' | 'reviewed'> }
  | { type: 'reviewed'; snapshot: ZoneLifecycleSnapshot }
  | { type: 'review-failed'; failure: 'denied' | 'sign-in' | 'unavailable' };

export function initialZoneLifecycleState(snapshot: ZoneLifecycleSnapshot): ZoneLifecycleEditorState {
  return { expectedHead: snapshot.revision, status: snapshot.status, selection: null,
    notice: 'idle', needsReview: false };
}

export function readZoneLifecycleSnapshot(revision: unknown, configuration: unknown): ZoneLifecycleSnapshot | null {
  if (typeof revision !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)
    || configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  const status = (configuration as { state?: unknown }).state;
  return status === 'active' || status === 'retired' ? { revision, status } : null;
}

export function reduceZoneLifecycle(state: ZoneLifecycleEditorState, event: ZoneLifecycleEvent): ZoneLifecycleEditorState {
  if (event.type === 'select') return { ...state, selection: event.action, notice: state.needsReview ? 'stale' : 'idle' };
  if (event.type === 'cancel') return { ...state, selection: null, notice: 'idle', needsReview: false };
  if (event.type === 'stale') return { ...state, notice: 'stale', needsReview: true };
  if (event.type === 'failed') return { ...state, notice: event.failure };
  if (event.type === 'review-failed') return { ...state, notice: event.failure };
  if (event.type === 'reviewed') return {
    ...state,
    expectedHead: event.snapshot.revision,
    status: event.snapshot.status,
    // A refresh replaces only the saved basis. Keep the action the author chose.
    selection: state.selection,
    notice: 'reviewed',
    needsReview: false,
  };
  return {
    expectedHead: event.snapshot.revision,
    status: event.snapshot.status,
    selection: null,
    notice: event.action === 'retire'
      ? event.replayed ? 'retired-replayed' : 'retired'
      : event.replayed ? 'recovered-replayed' : 'recovered',
    needsReview: false,
  };
}

export function zoneLifecycleTarget(action: ZoneLifecycleAction): ZoneLifecycleStatus {
  return action === 'retire' ? 'retired' : 'active';
}
