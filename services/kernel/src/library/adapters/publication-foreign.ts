/** Content publication adapter. Classifies private working versus activated public output. */

import type { ContentPublicationCapability } from '../contract/index.ts';
import { classifySourceOutput } from '../core/index.ts';

export function createContentPublicationAdapter(): ContentPublicationCapability {
  return {
    admitActivatedOutput(input) {
      const output = classifySourceOutput(input.observation);
      if (input.privateWorking && output === 'activated_public') return { admitted: false, reason: 'unavailable' };
      if (input.privateWorking) return { admitted: output === 'private_working', reason: 'private_working' };
      if (output === 'activated_public') return { admitted: true, reason: 'activated_public' };
      return { admitted: false, reason: 'unavailable' };
    },
  };
}
