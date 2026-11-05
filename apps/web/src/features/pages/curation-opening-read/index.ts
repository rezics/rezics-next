/** A private read is owned by a visit, independently of its promise subscribers. */
export type CurationOpeningRead<T> = {
  readonly signal: AbortSignal;
  readonly promise: Promise<T>;
  retire(): void;
};

export function startCurationOpeningRead<T>(read: (signal: AbortSignal) => Promise<T>): CurationOpeningRead<T> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    promise: Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return read(controller.signal);
    }),
    retire: () => controller.abort(),
  };
}

export type NativeOpeningInput = {
  headers: { authorization: string };
  fetch: { cache: 'no-store'; redirect: 'manual'; signal: AbortSignal };
};

export type NativeCurationOpeningClient<T> = {
  presentation: { curation: { get(input: NativeOpeningInput): Promise<T> } };
};

/** Admission of the response remains with the native-response consumer. */
export function readNativeCurationOpening<T>(
  client: NativeCurationOpeningClient<T>,
  authorization: string,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return client.presentation.curation.get({
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual', signal },
  });
}
