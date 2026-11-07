/** Source capture use case. Native prepare is a capability; this application classifies private vs public. */

import type {
  CollectionSource,
  SourceCaptureCapability,
  SourceCaptureResult,
  LibraryActor,
  WorkAllowance,
} from '../contract/index.ts';
import { classifySourceOutput } from '../core/index.ts';

/** Ordered Source continuation. Search holds this object through nested calls; it is not a process singleton. */
export function createOrderedCollectionSourceApplication(source: CollectionSource): CollectionSource {
  return {
    prepare: (input) => source.prepare(input),
    prefix: (input) => source.prefix(input),
    containsSubject: (input) => source.containsSubject(input),
    readRawStoredPrefix: (input) => source.readRawStoredPrefix(input),
    readRawOrdinalPrefix: (input) => source.readRawOrdinalPrefix(input),
  };
}

export function createSourceCaptureApplication(capabilities: { sourceCapture: SourceCaptureCapability }) {
  return {
    async capture(input: {
      actor: LibraryActor;
      collectionId: string;
      deadline: number;
      at: unknown;
      allowance: WorkAllowance;
      logical?: boolean;
      ordinaryPage?: boolean;
    }): Promise<SourceCaptureResult> {
      const prepared = await capabilities.sourceCapture.prepare({
        actor: input.actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: input.at,
        allowance: input.allowance,
        ...(input.logical !== undefined ? { logical: input.logical } : {}),
        ...(input.ordinaryPage !== undefined ? { ordinaryPage: input.ordinaryPage } : {}),
      });
      const output = classifySourceOutput(prepared.source.observation);
      if (input.logical && output !== 'private_working')
        throw new TypeError('The native Collection Source has no current logical built-in binding.');
      return {
        source: prepared.source,
        work: prepared.work,
        privateWorking: output === 'private_working',
      };
    },
  };
}

export type SourceCaptureApplication = ReturnType<typeof createSourceCaptureApplication>;
