import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { kernelClient } from '../../kernel/client';
import { publicRead } from '../../kernel/query';
import { loadRoutePage } from './route';

const readHomePage = createServerFn({ method: 'GET' }).handler(async () => loadRoutePage(kernelClient(), '/'));

export const homePageQuery = (locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['home-page', locale],
    queryFn: () => readHomePage(),
  });
