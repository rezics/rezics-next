import { routeOf } from '../route/route.ts';

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
