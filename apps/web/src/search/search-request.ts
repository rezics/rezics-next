import { problemCode } from './refinement/request';
export type SearchRequestPage = { sort?: string; cursor?: string; kindCursor?: string };
export type SearchResponsePage = { status: number; error?: unknown };

/** Read one result page, restarting exactly once when a native generation or Top rated cursor is no longer compatible. */
export async function readSearchPage<Response extends SearchResponsePage, Request extends SearchRequestPage>(
  request: Request,
  send: (request: Request | Omit<Request, 'cursor' | 'kindCursor'>) => Promise<Response>,
): Promise<{ response: Response; restarted: boolean }> {
  const response = await send(request);
  if (
    response.status !== 409 ||
    ((!request.kindCursor && !request.cursor) ||
      (!request.kindCursor && request.sort !== 'rating' && problemCode(response.error) !== 'search_restart_required'))
  )
    return { response, restarted: false };
  const { cursor: _cursor, kindCursor: _kindCursor, ...firstPage } = request;
  return { response: await send(firstPage), restarted: true };
}
