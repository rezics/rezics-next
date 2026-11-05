type RecordValue = Record<string, unknown>;
const serializedErrorMessage = 'rezics-platform-closed';

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recognizes only the kernel's account-independent platform gate refusal. */
export function isPlatformClosedProblem(status: unknown, body: unknown): boolean {
  return status === 403 && isRecord(body) && body.code === 'platform_closed';
}

export class PlatformClosedError extends Error {
  constructor(
    readonly status: number,
    readonly problem: unknown,
  ) {
    super(serializedErrorMessage);
    this.name = 'PlatformClosedError';
  }
}

export function isPlatformClosedError(error: unknown): error is PlatformClosedError {
  return (
    error instanceof PlatformClosedError ||
    (isRecord(error) && (error.name === 'PlatformClosedError' || error.message === serializedErrorMessage))
  );
}

/** Makes every kernel-client call surface a typed error for the shared route error boundary. */
export function withPlatformClosedRecognition<T>(client: T): T {
  function wrap(value: unknown): unknown {
    if ((typeof value !== 'function' && typeof value !== 'object') || value === null) return value;
    return new Proxy(value as (...args: unknown[]) => unknown, {
      get(target, property, receiver) {
        return wrap(Reflect.get(target, property, receiver));
      },
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        if (result instanceof Promise)
          return result.then((response: unknown) => {
            if (!isRecord(response)) return response;
            const error = response.error;
            const errorRecord = isRecord(error) ? error : undefined;
            const status = typeof response.status === 'number' ? response.status : errorRecord?.status;
            const body = errorRecord?.value;
            if (isPlatformClosedProblem(status, body)) throw new PlatformClosedError(status as number, body);
            return response;
          });
        return wrap(result);
      },
    });
  }

  return wrap(client) as T;
}
