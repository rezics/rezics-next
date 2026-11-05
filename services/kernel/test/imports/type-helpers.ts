type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export function fixtureFetch(
  handler: (input: FetchInput, init: FetchInit | undefined) => Promise<Response>,
): typeof fetch {
  const request = (input: FetchInput, init?: FetchInit) => handler(input, init);
  return Object.assign(request, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) });
}

type Current<T> = T extends { deleted: true } ? never : T;

export function currentCandidates<T extends { id: string }>(candidates: readonly T[]): Current<T>[] {
  return candidates.filter((candidate): candidate is Current<T> => !('deleted' in candidate));
}

export function valueContent(
  value: { type: 'value'; content: unknown } | { type: 'somevalue' } | { type: 'novalue' },
): unknown {
  return value.type === 'value' ? value.content : undefined;
}
