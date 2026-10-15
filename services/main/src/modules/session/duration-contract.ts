import type { SessionStatus } from './contract.ts';

/** Proposed API contract; no route or admission is implemented yet.
 * Policies and failure states: docs/architecture/activity-duration.md. */
export interface DurationCohort {
  /** Exact selected Resource, such as a release; never an implicit Work roll-up. */
  target: string;
  metric: string;
  /** Immutable DefinitionRef, including the playstyle and elapsed-time rule. */
  procedure: string;
  /** Null is explicitly unspecified, not a wildcard. */
  platform: string | null;
}

export type DurationResult =
  | { status: 'known'; value: string; unit: 'http://qudt.org/vocab/unit/SEC' }
  | { status: 'unknown'; value: null; unit: 'http://qudt.org/vocab/unit/SEC' };

/** PUT /v1/me/sessions/{id}/duration-observation; Idempotency-Key required.
 * Both version preconditions are checked before changing either owner. */
export interface SetSessionDurationRequest extends DurationCohort {
  profile: 'session-duration-observation-v1';
  actingSubject: string;
  expectedSessionVersion: number;
  expectedRevisionHead: string | null;
  result: DurationResult;
  contribution: 'private' | 'public-aggregate' | 'withdrawn';
}

/** GET on the same path takes only actingSubject and returns this private state.
 * No observation yet is { observation: null }; absent/foreign session is 404. */
export interface SessionDurationObservation extends DurationCohort {
  profile: 'session-duration-observation-v1';
  session: string;
  sessionVersion: number;
  sessionState: SessionStatus;
  observation: string;
  observationRevision: string;
  predecessor: string | null;
  result: DurationResult;
  contribution: SetSessionDurationRequest['contribution'];
  recordedAt: string;
}

export interface SetSessionDurationResponse {
  observation: SessionDurationObservation;
  receipt: string;
  replayed: boolean;
}

/** Proposed extension of each portable session row in GET /v1/me/library-export.
 * Null means no observation. Omission in an older bundle means not supplied.
 * Export keeps private records; it does not grant aggregate consent on import. */
export interface PortableSessionDuration {
  durationObservation: SessionDurationObservation | null;
}
