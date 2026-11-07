import type { ReactionFailure } from '../reaction-request';

/** An opaque original command for Home's existing page owner, independent of later advice. */
export type ReactionCommandRecovery = {
  start(command: {
    key: string;
    reader: string | null;
    credential: string | null;
    retry(): Promise<{ ok: true } | ReactionFailure>;
  }): void;
  uncertain(key: string): void;
  accepted(key: string): void;
};
