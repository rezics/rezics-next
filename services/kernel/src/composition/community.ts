import {
  ensureCommunityApplication,
  startCommunityApplication,
  tryCommunityApplication,
} from '../community/adapters/index.ts';
import type { CommunityAmbient, CommunityApplication } from '../community/contract/index.ts';

export { startCommunityApplication };

/** Ordinary createKernel/server/worker composition binds the native Community adapters. */
export function composeCommunityApplication(ambient?: Partial<CommunityAmbient>): CommunityApplication {
  return ensureCommunityApplication(ambient ?? {});
}

export function composedCommunityApplication(): CommunityApplication {
  return tryCommunityApplication() ?? composeCommunityApplication();
}
