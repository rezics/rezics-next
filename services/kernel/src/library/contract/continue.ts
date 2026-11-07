/** Disclosed Continue page vocabulary. HTTP schemas and native readers share these values. */

export type ContinueProgressRecording =
  | Readonly<{
      state: 'supported';
      inputRules: Readonly<{
        min?: string;
        max?: string;
        step: string;
        total: 'optional' | 'required' | 'forbidden';
      }>;
    }>
  | Readonly<{ state: 'unsupported' | 'unavailable' }>;

export type ContinueProgressPresentation = Readonly<{
  meaning: 'known' | 'unknown' | 'unavailable';
  unitLabel?: string;
  unitLabelLanguage?: string;
  unitCountForms?: Readonly<{
    other: string;
    zero?: string;
    one?: string;
    two?: string;
    few?: string;
    many?: string;
  }>;
  dimension?: string;
  structure: 'unverified';
  recording: ContinueProgressRecording;
}>;

export type ContinueSessionMeasure = Readonly<{
  unit: string;
  amount: string | null;
  total: string | null;
  presentation?: ContinueProgressPresentation;
}>;

export type ContinueSession = Readonly<{
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
  unit: string;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: 'active' | 'completed' | 'abandoned' | 'retired';
  revision: number;
  startedAt: string;
  completedAt: string | null;
  measures?: readonly ContinueSessionMeasure[];
}>;

export type ContinueSubjectFacts = Readonly<{
  subjectId: string;
  state: string | null;
  lastActivityAt: string;
  activeProgressSession: ContinueSession | null;
}>;

/** `Summary` is attached by the public-summary producer; Library contract does not import it. */
export type ContinueSubject<Summary = unknown> = ContinueSubjectFacts &
  Readonly<{
    subject?: Summary | null;
  }>;

export type ContinuePage<Summary = unknown> = Readonly<{
  subjects: readonly ContinueSubject<Summary>[];
  next: string | null;
}>;

export type ContinueListQuery = Readonly<{
  limit?: number;
  cursor?: string;
  view?: 'BASIC' | 'FULL';
  spaceId?: string;
  kind?: string;
}>;

export type ContinueActor =
  | Readonly<{ kind: 'account'; accountId: string; scopes: readonly string[] }>
  | Readonly<{ kind: 'anonymous' }>;

export type ContinueReads<Summary = unknown> = Readonly<{
  list(
    actor: ContinueActor,
    query: ContinueListQuery,
    deadline: number,
    languages?: readonly string[],
  ): Promise<ContinuePage<Summary>>;
}>;
