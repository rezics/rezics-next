export type SearchRequestPage = { sort?: string; cursor?: string };
export type SearchResponsePage = { status: number; error?: unknown };

/** Read one result page, restarting exactly once when a Top rated cursor is no longer compatible. */
export async function readSearchPage<Response extends SearchResponsePage, Request extends SearchRequestPage>(
  request: Request,
  send: (request: Request | Omit<Request, 'cursor'>) => Promise<Response>,
): Promise<{ response: Response; restarted: boolean }> {
  const response = await send(request);
  if (request.sort !== 'rating' || !request.cursor || response.status !== 409) return { response, restarted: false };
  const { cursor: _cursor, ...firstPage } = request;
  return { response: await send(firstPage), restarted: true };
}
