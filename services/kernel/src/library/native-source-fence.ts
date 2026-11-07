/** Stable structural fence shared by capture and native metadata. */
import { createHash } from 'node:crypto';
import type { NativeCollectionMetadata } from './collection-source-native.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeSourceFence(metadata: NativeCollectionMetadata): string {
  return hash([
    metadata.incarnation,
    metadata.stamp.epoch,
    metadata.authority,
    metadata.sourceGeneration,
    metadata.factFence,
    metadata.outputGeneration,
  ]);
}
