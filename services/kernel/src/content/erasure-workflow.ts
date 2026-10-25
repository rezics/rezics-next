import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { OperationProgress } from './operation-contract.ts';

export type NativeDurableStep = <T>(name: string, action: () => Promise<T>) => Promise<T>;

export interface ErasureCheckpointAdapter {
  read(operationId: string): Promise<OperationProgress | null>;
  write(operationId: string, progress: OperationProgress): Promise<void>;
}

export type AuthorErasureWorkflowDependencies = Readonly<{
  pool: Pool;
  access: Access;
  currentTime: () => Date;
  durableStep: NativeDurableStep;
  checkpoint: ErasureCheckpointAdapter;
}>;

export type AuthorErasureWorkflowResult = Readonly<{
  processedPosts: number;
  erasedRevisions: number;
}>;

/** Native author-erasure workflow port; storage and durable-step wiring is not implemented yet. */
export async function runAuthorErasure(
  _deps: AuthorErasureWorkflowDependencies,
  _operationId: string,
): Promise<AuthorErasureWorkflowResult> {
  throw new Error('Author erasure workflow is not implemented');
}
