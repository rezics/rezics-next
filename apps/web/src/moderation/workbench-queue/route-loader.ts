import type { QueryClient } from '@tanstack/react-query';
import { loadWorkbench, prepareWorkbenchRead, type WorkbenchReader } from './read';
import type { WorkbenchSearch } from './scope';

type LoaderInput = {
  deps: WorkbenchSearch;
  abortController: { signal: AbortSignal };
  context: { queryClient: QueryClient };
  location: { href: string; state: { __TSR_key?: string } };
};

/** The served loader and supplied-source review use the same preparation and visit boundary.
 * The default always reaches the production server reader, including its named unavailable seam.
 */
export function createWorkbenchLoader(
  read: WorkbenchReader = (data, signal) => loadWorkbench({ data, ...(signal ? { signal } : {}) }),
) {
  return async ({ deps, abortController, context, location }: LoaderInput) => {
    const page = await prepareWorkbenchRead(context.queryClient, deps, read, abortController.signal);
    return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
  };
}
