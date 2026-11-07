import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { kernelClient } from '../../kernel/client';
import { locales } from '../../paraglide/runtime.js';
import type { PublicCollectionDirectoryAddress } from '../contracts/collection-directory';
import { readPublicCollectionPage } from './read';

const inputSchema = v.object({
  locale: v.pipe(
    v.string(),
    v.check((value) => locales.some((locale) => locale === value)),
  ),
  presentationKind: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  curator: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  ),
  subject: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  ),
  order: v.optional(v.picklist(['recent', 'popular'])),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
});

const readPublicCollectionDiscoveryWithLocale = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(inputSchema, input))
  .handler(async ({ data }) => {
    const address: PublicCollectionDirectoryAddress = {
      ...(data.presentationKind === undefined ? {} : { presentationKind: data.presentationKind }),
      ...(data.curator === undefined ? {} : { curator: data.curator }),
      ...(data.subject === undefined ? {} : { subject: data.subject }),
      ...(data.order === undefined ? {} : { order: data.order }),
      ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
    };
    return readPublicCollectionPage(data.locale, address, async (request) =>
      kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal: getRequest().signal } }),
    );
  });

export function readPublicCollectionDiscovery({
  data,
  signal,
}: {
  data: { locale: string } & PublicCollectionDirectoryAddress;
  signal?: AbortSignal;
}) {
  return readPublicCollectionDiscoveryWithLocale({ data, ...(signal ? { signal } : {}) });
}
