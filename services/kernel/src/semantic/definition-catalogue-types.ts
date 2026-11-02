import type { KindCataloguePin, PinnedKindDeclaration } from '@rezics/definitions';
import type { OperationalTransaction } from '../command/operational.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { CollectionKindCapture } from '../library/collection-kind.ts';
import type { CollectionKindPreparationLocator } from '../library/collection-kind-work-admission.ts';

export type KindCatalogueConsumerKey = Readonly<{
  locator: CollectionKindPreparationLocator;
  capture: CollectionKindCapture;
  generation: string;
}>;
export type KindCatalogueConsumerRef = Readonly<{
  id: string;
  catalogue: KindCataloguePin;
  consumer: KindCatalogueConsumerKey;
  enrollmentGeneration: string;
  dependency: KindCatalogueWorkRead | null;
}>;
export type KindCatalogueNativeContext = Readonly<{
  tx: OperationalTransaction;
  work: NativeCollectionWork;
  deadline: number;
  consumer: KindCatalogueConsumerKey;
}>;
declare const preparedKindCatalogueRead: unique symbol;
export type PreparedKindCatalogueRead = Readonly<{ readonly [preparedKindCatalogueRead]: true }>;
export type KindCatalogueWorkRead =
  | Readonly<{ op: 'head' }>
  | Readonly<{ op: 'kinds'; pin: KindCataloguePin; ids: readonly string[] }>
  | Readonly<{ op: 'candidates'; pin: KindCataloguePin; exactTypeId: string; limit: number; cursor: string | null }>;
export type KindCatalogueWorkReadResult =
  | Readonly<{ op: 'head'; value: Readonly<{ pin: KindCataloguePin; head: number }> | null }>
  | Readonly<{ op: 'kinds'; values: readonly Readonly<{ id: string; value: PinnedKindDeclaration | null }>[] }>
  | Readonly<{ op: 'candidates'; values: readonly PinnedKindDeclaration[]; next: string | null }>;

/** A bounded receiving representation, never proof that the named job committed.
 * Only the native producer may select these fields when Core installs its genuine
 * pre-checkout association. A locator or encoded result cannot create that association.
 */
export type CatalogueMechanicalInput = Readonly<{
  format: 'catalogue-mechanical-input/1';
  root: string;
  episode: string;
  position: string;
  deadline: number;
}> & (
  | Readonly<{ phase: 'step'; buildTransactionId: string }>
  | Readonly<{ phase: 'activation-step'; activationId: string }>
);
export type CatalogueMechanicalResult =
  | Readonly<{ phase: 'step'; progress: import('./definition-catalogue-publication.ts').CatalogueBuildStatus }>
  | Readonly<{
      phase: 'activation-step';
      progress: import('./definition-catalogue-lifecycle.ts').CatalogueActivationProgress;
    }>;
