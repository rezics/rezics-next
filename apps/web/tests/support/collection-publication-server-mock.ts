import { mock } from 'bun:test';
import * as runtimeStart from '@tanstack/react-start';
import * as start from '../../.storybook/react-start';
import type {
  PublicationAddress,
  PublicationInput,
  PublicationPage,
  PublicationResult,
} from '../../src/library/collection-publication';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const reads: { address: PublicationAddress; work: ReturnType<typeof deferred<PublicationPage>> }[] = [];
export const writes: {
  input: PublicationInput;
  csrf: string | null;
  work: ReturnType<typeof deferred<PublicationResult>>;
}[] = [];

mock.module('@tanstack/react-start', () => ({
  ...start,
  ...runtimeStart,
  createServerFn() {
    const delegate = start.createServerFn();
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        delegate.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const original = delegate.handler(handler);
        return ((input?: { data: unknown; headers?: HeadersInit }) => {
          if (validate?.name === 'expectedSubject')
            return Promise.resolve({
              subject: validate(input?.data),
              admitted: ['collections'],
            });
          if (validate?.name === 'publicationAddress') {
            const call = { address: validate(input?.data) as PublicationAddress, work: deferred<PublicationPage>() };
            reads.push(call);
            return call.work.promise;
          }
          if (validate?.name === 'publicationInput') {
            const call = {
              input: validate(input?.data) as PublicationInput,
              csrf: new Headers(input?.headers).get('X-CSRF-Token'),
              work: deferred<PublicationResult>(),
            };
            writes.push(call);
            return call.work.promise;
          }
          return original(input as never);
        }) as T;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
