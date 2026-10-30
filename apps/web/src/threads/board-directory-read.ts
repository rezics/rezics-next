import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { boardDirectoryRequest, loadBoardDirectory } from './board-directory';

/** The route and retries use the current native collection through loadBoardDirectory's server-only default. */
export const readBoardDirectory = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new TypeError('Invalid board directory query');
    return boardDirectoryRequest({
      purpose: 'purpose' in input ? input.purpose : undefined,
      cursor: 'cursor' in input ? input.cursor : undefined,
      limit: 'limit' in input ? input.limit : undefined,
    });
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadBoardDirectory(data);
  });

export function boardDirectoryQuery(request: ReturnType<typeof boardDirectoryRequest>) {
  return {
    queryKey: ['board-directory', request],
    queryFn: () => readBoardDirectory({ data: request }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
  };
}
