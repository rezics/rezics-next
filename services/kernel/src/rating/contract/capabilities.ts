import type { DBOS } from '@dbos-inc/dbos-sdk';
import type { runCommand } from '../../command/command.ts';
import type { projectBatch } from '../../events/log.ts';

/** Current observations use this clock. Commands still mint their time inside the owning transaction. */
export type RatingAmbient = Readonly<{
  clock: () => Date;
  id: (route: number) => string;
  randomBytes: (length: number) => Uint8Array;
}>;

/** Runtime effects supplied once by native composition, shared by HTTP and durable work. */
export type RatingCapabilities = RatingAmbient &
  Readonly<{
    command: typeof runCommand;
    projectBatch: typeof projectBatch;
    workflows: Pick<typeof DBOS, 'registerStep' | 'registerWorkflow'>;
  }>;

export type RatingCapabilityOptions = {
  capabilities?: RatingCapabilities;
  /** Compatibility with callers that already supply the Kernel domain clock. */
  clock?: () => Date;
};
