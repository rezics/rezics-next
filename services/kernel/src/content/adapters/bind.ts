import { unbindContentRealmApplication } from './realm-binding.ts';
import { unbindFeedCapabilities } from './feed-bind.ts';
import type { ContentAmbient, ContentApplication } from '../contract/index.ts';

let bound: ContentApplication | undefined;

export function bindContentApplication(application: ContentApplication): ContentApplication {
  bound = application;
  return application;
}

export function contentApplication(): ContentApplication {
  if (!bound) throw new Error('Content application is not bound');
  return bound;
}

export function tryContentApplication(): ContentApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindContentApplication(): void {
  bound = undefined;
  unbindContentRealmApplication();
  unbindFeedCapabilities();
}

function boundAmbient(): ContentAmbient {
  if (!bound) throw new Error('Content application is not bound');
  return bound.ambient;
}

/** Request IDs come from the composed identity factory, never from a hidden UUID source. */
export function contentRequestId(): string {
  return boundAmbient().id();
}

/** Wall-clock budgets come from the composed `now`, never from a hidden Date.now. */
export function contentNow(): number {
  return boundAmbient().now();
}

/** Domain ranking and command time come from the composed clock. */
export function contentClock(): Date {
  return boundAmbient().clock();
}
