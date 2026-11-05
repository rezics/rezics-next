import { AsyncLocalStorage } from 'node:async_hooks';

/** Keep each observation's transport signal on its BFF Request, outside validated data. */
export function subjectReadServerFixture() {
  const requests = new AsyncLocalStorage<Request>();
  const signals: AbortSignal[] = [];
  return {
    signals,
    getRequest: () => requests.getStore()!,
    createServerFn: () => {
      let validate = (input: unknown) => input;
      const chain = {
        validator(next: typeof validate) {
          validate = next;
          return chain;
        },
        handler(handler: (input: { data: unknown }) => unknown) {
          return (input: { data?: unknown; signal?: AbortSignal } = {}) => {
            const request = new Request('https://site.test/subject', input.signal ? { signal: input.signal } : {});
            signals.push(request.signal);
            return requests.run(request, () => handler({ data: validate(input.data) }));
          };
        },
      };
      return chain;
    },
  };
}
