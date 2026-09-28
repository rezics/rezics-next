/** Public reads discard bearer authority while retaining the reader's ordered languages. */
export function publicLanguageRequest(request: Request, url: string | URL = request.url): Request {
  return new Request(url, { headers: {
    'accept-language': request.headers.get('accept-language') ?? '',
    'x-rezics-display-languages': request.headers.get('x-rezics-display-languages') ?? '',
  } });
}
