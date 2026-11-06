import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
import { currentCommand, type CommandTransaction } from '../../command/command.ts';
import sourceCommit from './platform-native-inverse-commit.sql';
import prearmDelete from './platform-native-inverse-prearm.sql';
import scopeDelete from './platform-native-inverse-scope.sql';

export const PLATFORM_NATIVE_INVERSE_REMOVAL_PURPOSE = 'identity-platform-native-inverse-removal';

export type PlatformNativeInverseLocator = Readonly<{
  home: number;
  generation: string;
  original: string;
  sourcePartition: number;
  captureId: string;
  registration: string;
  scopeKey: string;
  sourceKey: string;
}>;

/** Source-commit plus two inverse deletes. Native commit stays the caller's existing purpose. */
export function platformNativeInverseRemovalCost(): WorkDimensions {
  return Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 24,
    nativePoints: 8,
    witnessKeys: 0,
    statements: 3,
    bytes: 2048,
    emptySeeks: 0,
  });
}

/** Platform capture commands have no editorial write-basis. Record erasure-source provenance in this
 * home/T, then delete admitted inverses so prearm export and cancellation can close. */
export async function removePlatformNativeInverse(
  tx: CommandTransaction,
  locator: PlatformNativeInverseLocator,
): Promise<void> {
  const command = currentCommand(tx);
  if (command.basis !== null) throw new TypeError('Identity maintenance requires native admitted platform work');
  if (command.partition !== locator.home) throw new RangeError('Platform inverse removal is in another home');
  await tx.query(sourceCommit.sql, [locator.home, command.transactionId]);
  await tx.query(prearmDelete.sql, [
    locator.home,
    locator.generation,
    locator.original,
    locator.sourcePartition,
    locator.captureId,
    locator.registration,
    locator.scopeKey,
  ]);
  await tx.query(scopeDelete.sql, [
    locator.home,
    locator.generation,
    locator.original,
    locator.sourcePartition,
    locator.captureId,
    locator.registration,
    locator.sourceKey,
  ]);
}
