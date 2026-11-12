/** Source capture use case. Native prepare is a capability; this application classifies private vs public. */

import type {
  CollectionSource,
  SourceCaptureCapability,
  SourceCaptureResult,
  LibraryActor,
  WorkAllowance,
} from '../contract/index.ts';
import { classifySourceOutput } from '../core/index.ts';
import { ProblemError } from '../../http/problem-error.ts';

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
      source?: Pick<CollectionSource, 'prepare'>;
      logical?: boolean;
      ordinaryPage?: boolean;
    }): Promise<SourceCaptureResult> {
      if (input.logical && !input.source)
        throw new ProblemError('dependency_unavailable', {
          detail: 'Logical built-ins require the caller’s registered Collection Source.',
        });
      const prepared = await capabilities.sourceCapture.prepare({
        actor: input.actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: input.at,
        allowance: input.allowance,
        ...(input.source ? { source: input.source } : {}),
        ...(input.logical !== undefined ? { logical: input.logical } : {}),
        ...(input.ordinaryPage !== undefined ? { ordinaryPage: input.ordinaryPage } : {}),
      });
      const observation = prepared.source.observation;
      const output = classifySourceOutput(observation);
      if (
        input.logical &&
        (output !== 'private_working' ||
          observation.collectionId !== input.collectionId ||
          observation.authority.kind !== 'private_builtin' ||
          input.actor.kind !== 'account' ||
          observation.authority.curatorAccountId !== input.actor.accountId)
      )
        throw new ProblemError('dependency_unavailable', {
          detail: 'The caller’s Collection Source has no current owner-bound logical built-in observation.',
        });
      return {
        source: prepared.source,
        work: prepared.work,
        privateWorking: output === 'private_working',
      };
    },
  };
}

export type SourceCaptureApplication = ReturnType<typeof createSourceCaptureApplication>;
