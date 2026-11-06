/** Source capture use case. Native prepare is a capability; this application classifies private vs public. */

import type { SourceCaptureCapability } from '../contract/index.ts';
import type { SourceCaptureResult } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import type { WorkAllowance } from '../contract/work-dimensions.ts';
import { classifySourceOutput } from '../core/index.ts';

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
