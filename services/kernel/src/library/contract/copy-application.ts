import type { LibraryActor, LibraryAccountActor } from './actors.ts';
import type { CopyInput, CopyPatch, CopyPageOptions } from './copy-values.ts';
import type { LibraryCursorBinding } from './cursor.ts';
import type {
  CopyOperationPlan,
  CopyMutationOperation,
  CopyMutationOperationInput,
  CopyInventoryOperationInput,
} from './copy-operations.ts';

/** Native slots retain producer types, branded time, transaction and receipt identities without importing adapters. */
export interface CopyNativeTypes {
  transaction: unknown;
  time: unknown;
  attempt: unknown;
  command: unknown;
  outcome: unknown;
  copy: {
    id: string;
    accountId: string;
    subjectId: string;
    revision: number;
    createdAt: string;
    status: string;
    disposedOn: string | null;
  };
  fact: { copy: CopyNativeTypes['copy'] };
  source: { subjectId: string } | null;
  observation: unknown;
  retained: unknown;
  detail: { copy: CopyNativeTypes['copy'] };
  presentation: unknown;
  inventory: unknown;
  inventoryValues: unknown;
}
export type CopyRestoreInput = { copyId: string; deletionId: string; revision: number };
export type CopyCursorBinding = LibraryCursorBinding;
export type CopyCommandSpec<N extends CopyNativeTypes, Prepared> = {
  action: string;
  kind: string;
  requestKey: string;
  input: unknown;
  deadline: number;
  execution<T>(dispatch: () => Promise<T>): Promise<T>;
  prepare(attempt: N['attempt'], at: N['time']): Promise<Prepared>;
};
export type CopyEvent = { type: string; subject: string; data: { copyId: string } };

/** Library declares the effects; composition supplies the native owners. No port creates a second command writer. */
export interface CopyApplicationPorts<N extends CopyNativeTypes> {
  deadline(): number;
  remaining(deadline: number): number;
  newId(route: number): string;
  requireRoute(id: string): number;
  sameAccountRoute(accountId: string, copyId: string): number;
  denied(): Error;
  notFound(): Error;
  problem(
    code:
      | 'semantic_not_ready'
      | 'invalid_cursor'
      | 'stale_cursor'
      | 'copy_restore_occupied'
      | 'copy_restore_stale'
      | 'copy_restore_expired',
  ): Error;
  gate(owner: LibraryAccountActor, deadline: number): Promise<void>;
  readOnly<T>(owner: LibraryAccountActor, body: (client: N['transaction']) => Promise<T>, deadline: number): Promise<T>;
  within<T>(deadline: number, body: () => Promise<T>): Promise<T>;
  request<T>(deadline: number, body: () => Promise<T>): Promise<T>;
  time(deadline: number): Promise<N['time']>;
  releaseTime(at: N['time']): void;
  receiptKeys(): number;
  run<Prepared>(
    owner: LibraryAccountActor,
    spec: CopyCommandSpec<N, Prepared>,
    body: (
      tx: N['transaction'],
      command: N['command'],
      prepared: Prepared,
    ) => Promise<{ value: N['copy']; events: CopyEvent[] }>,
  ): Promise<N['outcome']>;
  admitAttempt(
    owner: LibraryAccountActor,
    action: 'copy:create' | 'copy:update' | 'copy:delete',
    attempt: N['attempt'],
    deadline: number,
  ): Promise<void>;
  plans: {
    gate(route: number, accountId: string): CopyOperationPlan;
    mutation(operation: CopyMutationOperation, input: CopyMutationOperationInput): CopyOperationPlan;
    read(route: number, accountId: string, copyId: string): CopyOperationPlan;
    presentation(route: number, accountId: string, copyId: string, subjectId: string): CopyOperationPlan;
    inventory(input: CopyInventoryOperationInput): CopyOperationPlan;
  };
  execute<T>(plan: CopyOperationPlan, body: () => Promise<T>): Promise<T>;
  bind<T>(plan: CopyOperationPlan, body: () => Promise<T>): Promise<T>;
  consume(plan: CopyOperationPlan): Promise<void>;
  source(owner: LibraryAccountActor, subjectId: string, at: N['time'], deadline: number): Promise<N['observation']>;
  currentSource(before: N['observation'], after: N['observation']): N['source'];
  read(tx: N['transaction'], route: number, copyId: string): Promise<N['copy'] | null>;
  lock(tx: N['transaction'], route: number, accountId: string, copyId: string): Promise<N['copy']>;
  fact(tx: N['transaction'], route: number, copyId: string): Promise<(N['fact'] & { copy: N['copy'] }) | null>;
  noOpenLoan(tx: N['transaction'], route: number, accountId: string, copyId: string): Promise<void>;
  insert(
    tx: N['transaction'],
    command: N['command'],
    route: number,
    accountId: string,
    copyId: string,
    input: CopyInput & { kind: string; status: string },
    source: NonNullable<N['source']>,
  ): Promise<N['copy']>;
  update(
    tx: N['transaction'],
    command: N['command'],
    route: number,
    copyId: string,
    patch: CopyPatch,
    fact: N['fact'],
    source: NonNullable<N['source']>,
  ): Promise<N['copy'] | null>;
  delete(
    tx: N['transaction'],
    command: N['command'],
    route: number,
    copyId: string,
    revision: number,
  ): Promise<boolean>;
  privateRead(tx: N['transaction'], route: number, accountId: string, copyId: string): Promise<N['retained'] | null>;
  validateRetained(
    owner: LibraryAccountActor,
    row: N['retained'],
    attempt: N['attempt'],
    deadline: number,
  ): Promise<void>;
  retention(
    tx: N['transaction'],
    command: N['command'],
    route: number,
    accountId: string,
    copyId: string,
  ): Promise<{ deletionId: string | null; revision: number; expired: boolean | null } | null>;
  restore(
    tx: N['transaction'],
    command: N['command'],
    route: number,
    accountId: string,
    input: CopyRestoreInput,
  ): Promise<boolean>;
  observeDetail(
    owner: LibraryAccountActor,
    route: number,
    copyId: string,
    at: N['time'],
    deadline: number,
  ): Promise<{ fact: N['detail'] & { copy: N['copy'] }; epoch: number }>;
  presentation(
    owner: LibraryAccountActor,
    fact: N['detail'],
    at: N['time'],
    deadline: number,
    languages: readonly string[],
  ): Promise<{
    presentation: N['presentation'];
    disclosure: { subject: boolean };
    verify(at: N['time']): Promise<void>;
  }>;
  partition(tx: N['transaction'], route: number): Promise<{ epoch: number } | null>;
  decodeCursor(
    binding: CopyCursorBinding,
    cursor: string,
  ): { ok: false } | { ok: true; epoch: number; after: readonly unknown[] };
  encodeCursor(binding: CopyCursorBinding, cursor: { epoch: number; after: readonly string[] }): string;
  page(
    tx: N['transaction'],
    route: number,
    accountId: string,
    page: { after: { createdAt: string; copyId: string } | null; limit: number },
    subjectId: string | null,
    kind: string | null,
    status: string | null,
  ): Promise<N['copy'][]>;
  inventoryValues(tx: N['transaction'], route: number, accountId: string): Promise<N['inventoryValues']>;
  inventory(values: N['inventoryValues'], deadline: number, languages: readonly string[]): Promise<N['inventory']>;
}

export interface CopyApplication<N extends CopyNativeTypes> {
  createCopy(actor: LibraryActor, input: unknown, requestKey: string): Promise<N['outcome']>;
  updateCopy(actor: LibraryActor, copyId: string, input: unknown, requestKey: string): Promise<N['outcome']>;
  deleteCopy(
    actor: LibraryActor,
    copyId: string,
    revision: number | undefined,
    requestKey: string,
  ): Promise<N['outcome']>;
  restoreCopy(actor: LibraryActor, copyId: string, input: unknown, requestKey: string): Promise<N['outcome']>;
  readCopy(actor: LibraryActor, copyId: string): Promise<N['copy']>;
  readPresentedCopy(
    actor: LibraryActor,
    copyId: string,
    languages?: readonly string[],
  ): Promise<N['copy'] & { presentation: N['presentation'] }>;
  readPresentedCopy<T>(
    actor: LibraryActor,
    copyId: string,
    languages: readonly string[],
    render: (copy: N['copy'], presentation: N['presentation'], disclosure: { subject: boolean }) => Promise<T>,
  ): Promise<T>;
  listCopies(actor: LibraryActor, options?: CopyPageOptions): Promise<{ copies: N['copy'][]; next: string | null }>;
  listCopiesWithObservation(
    actor: LibraryActor,
    options?: CopyPageOptions,
    languages?: readonly string[],
  ): Promise<{ copies: N['copy'][]; next: string | null; accountEpoch: number | null; filterOptions: N['inventory'] }>;
}

/** Foreign producers implement these Library-required capabilities with their own public contracts. */
export interface CopyAccountAuthority<Client, Owner, Time> {
  admit(client: Client, owner: Owner): Promise<void>;
  check(
    owner: Owner,
    route: number,
    at: Time,
    deadline: number,
  ): Promise<(client: Client, at: Time) => Promise<boolean>>;
  denied(): Error;
}
export interface CopyReleasedDefinitions<Source, Release> {
  read(source: Source, digest: string, options?: Readonly<{ composed?: boolean }>): Promise<Release | null>;
  active(source: Source): Promise<{ digest: string; release: Release } | null>;
}
