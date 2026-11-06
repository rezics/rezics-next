/** Content publication adapter. Classifies private working versus activated public output and cover facts. */

import type { ContentPublicationCapability, LibraryCoverSummary } from '../contract/index.ts';
import { classifySourceOutput } from '../core/index.ts';

export type ContentPublicationAdapterPorts = Readonly<{
  readableCover(input: {
    actor: Parameters<ContentPublicationCapability['readableCover']>[0]['actor'];
    mediaId: string;
    deadline: number;
    routeKey?: Uint8Array;
    clock?: () => Date;
  }): Promise<LibraryCoverSummary | null>;
}>;

export function createContentPublicationAdapter(
  ports: ContentPublicationAdapterPorts = {
    async readableCover() {
      return null;
    },
  },
): ContentPublicationCapability {
  return {
    admitActivatedOutput(input) {
      const output = classifySourceOutput(input.observation);
      if (input.privateWorking && output === 'activated_public') return { admitted: false, reason: 'unavailable' };
      if (input.privateWorking) return { admitted: output === 'private_working', reason: 'private_working' };
      if (output === 'activated_public') return { admitted: true, reason: 'activated_public' };
      return { admitted: false, reason: 'unavailable' };
    },
    readableCover(input) {
      return ports.readableCover(input);
    },
  };
}
