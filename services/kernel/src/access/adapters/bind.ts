import type { AccessApplication } from '../contract/index.ts';

let bound: AccessApplication | undefined;

export function bindAccessApplication(application: AccessApplication): AccessApplication {
  bound = application;
  return application;
}

export function accessApplication(): AccessApplication {
  if (!bound) throw new Error('Access application is not bound');
  return bound;
}

export function tryAccessApplication(): AccessApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindAccessApplication(): void {
  bound = undefined;
}
