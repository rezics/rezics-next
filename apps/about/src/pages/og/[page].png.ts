import type { APIRoute, GetStaticPaths } from 'astro';
import { englishPage } from '../../i18n/format.ts';
import { ogImage } from '../../lib/og.ts';
import { pageIds, pageSlug, type PageId } from '../../pages.ts';

/** One share image per page, drawn at build time; the slug of Home is `home`. */
export const getStaticPaths = (() =>
  pageIds.map((page) => ({
    params: { page: page === 'home' ? 'home' : pageSlug(page) },
    props: { page },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: PageId }> = async ({ props }) => {
  const { name, summary } = englishPage(props.page);
  const title = props.page === 'home' ? 'Your reading, in every language and edition.' : name;
  return new Response(
    new Uint8Array(await ogImage(title, props.page === 'home' ? 'REZICS' : summary)),
    { headers: { 'content-type': 'image/png' } },
  );
};
