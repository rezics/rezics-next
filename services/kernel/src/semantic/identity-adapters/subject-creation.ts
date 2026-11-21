import type { CommandTransaction } from '../../command/command.ts';
import { routeOf, partitionOf } from '../../route/route.ts';
import { IdentityEpochStoreError } from '../contract/identity-errors.ts';
import { nativeIdentityCapabilities } from '../identity-adapter-bind.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import type { IdentityEpochStore } from './identity-epoch-contract.ts';

const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Identity source, native group generation or bootstrap closure is not current',
  );

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Identity original must be a native routed ID');
  return value;
}

/** Same-transaction birth mapping; no identity job or participant is loaded or inferred. */
export function createIdentitySubjectInitializer(
  capabilities: NativeIdentityCapabilities,
): IdentityEpochStore['initializeSubject'] {
  const cmd = () => capabilities.command;
  return async (tx, original) => {
    const command = cmd().currentCommand(tx);
    const originalRoute = route(original);
    if (command.partition !== partitionOf(originalRoute)) throw new TypeError('Wrong subject creation home');
    if (
      command.basis !== null &&
      (!command.authorization ||
        command.authorization.action !== 'subject:create' ||
        command.authorization.mode !== 'execute')
    )
      throw new TypeError('Exact self requires native subject:create authorization');
    const {
      rows: [birth],
    } = await tx.query<{ status: string; source_transaction: string | null }>(
      'SELECT status,source_transaction FROM semantic.initialize_identity_birth($1::integer,$2::uuid)',
      [originalRoute, original],
    );
    if (birth?.status === 'missing')
      throw new TypeError('initializeSubject requires the same native creation transaction');
    if (birth?.status === 'conflict')
      throw new TypeError('Identity self mapping already exists outside this exact creation transaction');
    if (birth?.status === 'existing') return;
    if (birth?.status !== 'created' || !birth.source_transaction) throw unavailable();
    cmd().registerCommandCallback(tx, async (transactionId) => {
      if (transactionId !== birth.source_transaction)
        throw new TypeError('initializeSubject requires the executor native creation transaction');
    });
  };
}

export function initializeIdentitySubject(tx: CommandTransaction, original: string): Promise<void> {
  return createIdentitySubjectInitializer(nativeIdentityCapabilities())(tx, original);
}
