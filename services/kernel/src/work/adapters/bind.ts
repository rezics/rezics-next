import type { WorkApplication } from '../contract/index.ts';

let bound: WorkApplication | undefined;

export function bindWorkApplication(application: WorkApplication): WorkApplication {
  bound = application;
  return application;
}

export function workApplication(): WorkApplication {
  if (!bound) throw new Error('Work application is not bound');
  return bound;
}

export function tryWorkApplication(): WorkApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel/server/worker rebind native ports. */
export function unbindWorkApplication(): void {
  bound = undefined;
}
