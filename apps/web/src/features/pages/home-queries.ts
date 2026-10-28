import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { kernelClient } from '../../kernel/client';
import { publicRead } from '../../kernel/query';
import { validatePublicOrigin } from '../../shell/origin';
import { loadRoutePage } from './route';

const readHomePage = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  const page = await loadRoutePage(kernelClient(), '/');
  const origin = validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN);
  return { ...page, origin };
});

export const homePageQuery = (locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['home-page', locale],
    queryFn: () => readHomePage(),
  });
