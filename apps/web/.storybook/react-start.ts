/** Server functions are outside the browser-only stories. */
export function createServerFn() {
  return {
    validator() {
      return this;
    },
    handler<T extends (...args: never[]) => unknown>(handler: T): T {
      return handler;
    },
  };
}
