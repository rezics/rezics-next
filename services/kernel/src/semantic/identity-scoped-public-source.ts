/** Provisional Semantic producer adapter. No I/O, capture or readiness is fabricated. */
import type { CommandTransaction } from '../command/command.ts';
import type {
  PublicFilterSourceFactory,
  PublicFilterReadContext,
  PublicFilterCost,
} from './public-filter-source-contract.ts';
import type { PublicFilterSourceDefinition } from './public-filter-source-binding.ts';
declare const publicSourceCapture: unique symbol;
export type PublicIdentitySourceCapture = Readonly<{ [publicSourceCapture]: true }>;
export type PublicIdentitySourceCapturePage =
  | Readonly<{
      status: 'progress';
      captureId: string;
      frontier: string;
      originals: readonly string[];
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      captureId: string;
      frontier: null;
      originals: readonly string[];
      capture: PublicIdentitySourceCapture;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;
export type PublicIdentitySourceCaptureProducer = Readonly<{
  capturePage(
    request: Readonly<{
      definition: PublicFilterSourceDefinition;
      frontier: string | null;
      inputLimit: number;
      context: PublicFilterReadContext;
    }>,
  ): Promise<PublicIdentitySourceCapturePage>;
}>;
export function createPublicIdentitySourceCapture(
  config: Parameters<PublicFilterSourceFactory>[0],
): PublicIdentitySourceCaptureProducer {
  return {
    async capturePage() {
      return { status: 'unavailable', cost: unavailableCost() };
    },
  };
}
export function verifyPublicIdentitySourceCapture(
  tx: CommandTransaction,
  capture: PublicIdentitySourceCapture,
): Promise<boolean> {
  return Promise.resolve(false);
}

function unavailableCost(): PublicFilterCost {
  return {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
}
