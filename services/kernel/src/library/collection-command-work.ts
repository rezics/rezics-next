/** Mechanical Library execution plumbing. No command, authorization or shelf implementations. */
import type { Bound } from '@rezics/bounds';
import {
  currentCommandWorkAssociation,
  currentLibraryOperationAccounting,
  withLibraryOperationAccounting,
} from '../command/work-context.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';

/** Bind a closed Library SQL declaration to the caller's existing accounting frame. */
export function runLibraryBoundedStep<T>(operation: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  if (!association) return dispatch();
  const { engineRequests: _engineRequests, ...work } = bound;
  return association.run(operation, work, dispatch);
}

/** Reserve one complete Library operation, then run its leaves on the same caller-owned resources. */
export async function runLibraryBoundedOperation<T>(
  operation: string,
  bound: Bound,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  // The existing native association accepts eight axes; engineRequests stays in the full operation declaration.
  const { engineRequests: _engineRequests, ...work } = bound;
  const reservation = association?.reserve(operation, work);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reservation?.settle();
  };
  try {
    const result = await withLibraryOperationAccounting(operation, dispatch);
    settle();
    return result;
  } catch (error) {
    settle();
    throw error;
  }
}

/** Shared deadline policy for native Library work steps outside actor commands. */
export function workStepDeadline(): number {
  return currentCommandWorkAssociation()?.deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
}

export class LibraryNotFoundError extends Error {
  constructor() {
    super('Library item not found');
    this.name = 'LibraryNotFoundError';
  }
}

/** Return the route encoded by an ID, mapping invalid IDs to the library not-found result. */
export function requireRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new LibraryNotFoundError();
  return route;
}

/** Keep an ID on its owning account route and conceal foreign or malformed IDs. */
export function sameAccountRoute(accountId: string, id: string): number {
  const accountRoute = requireRoute(accountId);
  if (requireRoute(id) !== accountRoute) throw new LibraryNotFoundError();
  return accountRoute;
}
