type Visitor = 'Signed In' | 'Signed Out';
type StoryContext = { visitor: Visitor; url: string };

type StoryGlobals = typeof globalThis & { __rezicsStoryContext?: StoryContext };

export function setStoryRequestContext(context: StoryContext): void {
  (globalThis as StoryGlobals).__rezicsStoryContext = context;
}

function requestForStory(): Request {
  const storyContext = (globalThis as StoryGlobals).__rezicsStoryContext;
  const url = new URL(storyContext?.url ?? window.location.href, window.location.origin);
  const headers = new Headers({
    host: url.host,
    'x-forwarded-proto': url.protocol.slice(0, -1),
  });
  const request = new Request(url, { headers });
  if (storyContext?.visitor === 'Signed In') {
    // Browsers strip Cookie from Request headers, so expose the recorded session to route handlers locally.
    const requestHeaders = new Headers(request.headers);
    const getHeader = requestHeaders.get.bind(requestHeaders);
    Object.defineProperty(requestHeaders, 'get', {
      value: (name: string) =>
        name.toLowerCase() === 'cookie' ? `__Host-rezics_session=${'a'.repeat(43)}` : getHeader(name),
    });
    Object.defineProperty(request, 'headers', { value: requestHeaders });
  }
  return request;
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

/** Story handlers execute locally against the fake, including server-only transports. */
export function createServerOnlyFn<T extends (...args: never[]) => unknown>(handler: T): T {
  return handler;
}
