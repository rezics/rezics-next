import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../../kernel/client';
import { readRecordingRelease } from './read';

export const loadRecordingRelease = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => (typeof input === 'string' && input.length <= 128 ? input : ''))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readRecordingRelease(kernelClient(), data);
  });
