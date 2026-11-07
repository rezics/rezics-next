import type { CommunityAmbient, CommunityApplication } from '../contract/index.ts';

let bound: CommunityApplication | undefined;

export function bindCommunityApplication(application: CommunityApplication): CommunityApplication {
  bound = application;
  return application;
}

export function communityApplication(): CommunityApplication {
  if (!bound) throw new Error('Community application is not bound');
  return bound;
}

export function tryCommunityApplication(): CommunityApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindCommunityApplication(): void {
  bound = undefined;
}

function boundAmbient(): CommunityAmbient {
  if (!bound) throw new Error('Community application is not bound');
  return bound.ambient;
}

/** Wall-clock budgets come from the composed `deadlineNow`, never from a hidden Date.now. */
export function communityDeadlineNow(): number {
  return boundAmbient().deadlineNow();
}
