import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readArc, validArcAddress, type ArcAddress } from './model';

export const loadArcReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: ArcAddress) => {
    if (!validArcAddress(input)) throw new Error('Invalid story arc window');
    return {
      id: input.id,
      context: input.context,
      ...(input.arc ? { arc: input.arc } : {}),
      ...(input.stream ? { stream: input.stream } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const client = kernelClient(locale);
    return readArc(client, fetchGuideRelease(client), data, locale);
  });
