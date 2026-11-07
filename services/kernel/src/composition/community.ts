import { composeCommunityDomainPorts } from './community-domain-ports.ts';
import {
  ensureCommunityApplication,
  startCommunityApplication as startNativeCommunityApplication,
  tryCommunityApplication,
} from '../community/adapters/index.ts';
import type { CommunityAmbient, CommunityApplication } from '../community/contract/index.ts';

export function startCommunityApplication(ambient: Partial<CommunityAmbient> = {}) {
  composeCommunityDomainPorts();
  return startNativeCommunityApplication(ambient);
}

/** Ordinary createKernel/server/worker composition binds the native Community adapters. */
export function composeCommunityApplication(ambient?: Partial<CommunityAmbient>): CommunityApplication {
  composeCommunityDomainPorts();
  return ensureCommunityApplication(ambient ?? {});
}

export function composedCommunityApplication(): CommunityApplication {
  return tryCommunityApplication() ?? composeCommunityApplication();
}
