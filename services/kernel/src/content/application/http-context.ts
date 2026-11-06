import type { ContentAmbient, ContentHttpRequestContext } from '../contract/index.ts';

/** HTTP command context is identity plus the request deadline. The ambient supplies the request id. */
export function createHttpContext(ambient: Pick<ContentAmbient, 'id'>) {
  return {
    requestContext(deadline: number, idempotencyKey?: string | null): ContentHttpRequestContext {
      return {
        deadline,
        requestId: ambient.id(),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
    },
  };
}
