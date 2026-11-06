import type { ContentApplication } from '../contract/index.ts';

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
}
