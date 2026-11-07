import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { BatchStatement } from '@rezics/definitions/bulk';
import type { Violation } from '@rezics/definitions/validate';
import type { CandidateFailure } from '../pages/visit-host-port';
import type { CandidateViewerActions } from '../../subject/candidate-contract';

type EditorStatement = SubjectRead['subject']['statements'][string][number];

export type SnakInput = Pick<BatchStatement, 'property' | 'value'>;
export type StatementInput = Omit<BatchStatement, 'qualifiers' | 'references'> & {
  qualifiers?: SnakInput[];
  references: { parts: SnakInput[] }[];
};

export type EditorAddress = { id: string; property?: string; statement?: string };
export type EditorRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      release: Release;
      source: EditorStatement | null;
      /** Missing action data is never treated as a confirmed empty permission set. */
      actions?: CandidateViewerActions;
    };

export type ProposalCommand = { id: string; key: string; statement: StatementInput };
export type ProposalResult =
  | (CandidateFailure & { errors?: Violation[]; refreshDefinitions?: boolean })
  | {
      ok: true;
      kind: 'proposed-awaiting-review';
      candidate: string;
      revision: number;
      session?: string;
    };

export type EditorTransport = {
  read: () => Promise<EditorRead>;
  propose: (command: ProposalCommand) => Promise<ProposalResult>;
};

/** Disclosed related summaries a statement value renderer may label; it never hydrates a target. */
export type StatementRelated = Record<string, { labels?: Record<string, string>; type?: string; redirect?: string }>;

export type StatementScalarRead = {
  release: Pick<Release, 'types' | 'properties'>;
  public: { related: StatementRelated };
};

/** Creation has no subject DTO or invented identity; controls need only its chosen Type and related summaries. */
export type StatementFieldsRead = StatementScalarRead & {
  source: EditorStatement | null;
  public: StatementScalarRead['public'] & { subject: { type: string } };
};

export type EditorReload = {
  read: EditorRead;
  draft?: StatementInput;
  baseline?: StatementInput;
};

export type ProposalDecision = { blocked: true } | { errors: Violation[] } | { ready: true };

export function isStatementRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
