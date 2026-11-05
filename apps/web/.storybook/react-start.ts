type Visitor = 'Signed In' | 'Signed Out';
type StoryContext = { visitor: Visitor; url: string };

type StoryGlobals = typeof globalThis & { __rezicsStoryContext?: StoryContext };

export function setStoryRequestContext(context: StoryContext): void {
  (globalThis as StoryGlobals).__rezicsStoryContext = context;
}

function withStoryHeaders(request: Request, headers: Headers, cookie: string | null): Request {
  // Browser Request guards strip Cookie. Keep this server-only observation local,
  // including when a reader clones the request for a fresh session preparation.
  const getHeader = headers.get.bind(headers);
  Object.defineProperty(headers, 'get', {
    value: (name: string) => (name.toLowerCase() === 'cookie' ? cookie : getHeader(name)),
  });
  const clone = request.clone.bind(request);
  Object.defineProperty(request, 'headers', { value: headers });
  Object.defineProperty(request, 'clone', {
    value: () => withStoryHeaders(clone() as Request, new Headers(headers), headers.get('cookie')),
  });
  return request;
}

export function requestForStory(input?: RequestInfo | URL, init?: RequestInit): Request {
  const storyContext = (globalThis as StoryGlobals).__rezicsStoryContext;
  const page = new URL(storyContext?.url ?? window.location.href, window.location.origin);
  const target = input instanceof Request ? input : new URL(input === undefined ? page.href : String(input), page);
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
  const request = new Request(target, init);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
  if (input !== undefined && !headers.has('referer'))
    headers.set('referer', request.referrer && request.referrer !== 'about:client' ? request.referrer : page.href);
  const cookie =
    headers.get('cookie') ??
    (storyContext?.visitor === 'Signed In' && credentials !== 'omit'
      ? `__Host-rezics_session=${'a'.repeat(43)}`
      : null);
  return withStoryHeaders(request, headers, cookie);
}

/** The story route handlers run in the browser against the Storybook request context. */
export function createServerFn() {
  let validate: ((input: unknown) => unknown) | undefined;
  const chain = {
    validator(next: (input: unknown) => unknown) {
      validate = next;
      return chain;
    },
    handler<T extends (...args: never[]) => unknown>(handler: T): T {
      return ((input?: unknown) => {
        let result: unknown;
        if (validate && input && typeof input === 'object' && 'data' in input) {
          const supplied = input as { data: unknown };
          result = handler({ ...supplied, data: validate(supplied.data) } as never);
        } else {
          result = handler((input ?? {}) as never);
        }
        return Promise.resolve(result).then((value) => {
          const context = (globalThis as StoryGlobals).__rezicsStoryContext;
          // Label read envelopes carry CSRF too; preserve their page-state discriminant.
          if (
            value &&
            typeof value === 'object' &&
            (('labels' in value && 'operations' in value) || ('label' in value && 'entries' in value))
          )
            return value;
          if (context && value && typeof value === 'object' && 'state' in value && 'csrfToken' in value) {
            return {
              ...value,
              state: context.visitor === 'Signed In' ? 'signed-in' : 'signed-out',
              csrfToken: context.visitor === 'Signed In' ? 'story-csrf-token' : null,
            };
          }
          return value;
        });
      }) as unknown as T;
    },
  };
  return chain;
}

/** Use the client implementation of isomorphic functions while Storybook renders in a browser. */
export function createIsomorphicFn() {
  let clientHandler: (...args: never[]) => unknown = () => undefined;
  const client = ((...args: never[]) => clientHandler(...args)) as (...args: never[]) => unknown;
  const chain = {
    server(_handler: (...args: never[]) => unknown) {
      return chain;
    },
    client(handler: (...args: never[]) => unknown) {
      clientHandler = handler;
      return client;
    },
  };
  return chain;
}

export function getRequest(): Request {
  return requestForStory();
}

export function getRequestHeader(name: string): string | null {
  return requestForStory().headers.get(name);
}

export function setResponseHeader(_name: string, _value: string): void {}

export function setResponseStatus(_status: number, _statusText?: string): void {}

export function getResponseStatus(): number {
  return 200;
}

/** Story handlers execute locally against the fake, including server-only transports. */
export function createServerOnlyFn<T extends (...args: never[]) => unknown>(handler: T): T {
  return handler;
}
