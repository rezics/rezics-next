import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { uiLocales } from '../i18n/locales.ts';
import { absoluteUrl, alternates } from '../lib/site.ts';
import { pageIds, pagePath } from '../pages.ts';

/** Every localized page with its alternates, `x-default` included (each URL lists all of them, itself too). */
export const GET: APIRoute = async ({ site }) => {
  // Policies are listed only in a release build; a draft build is noindex.
  const policies = (await getCollection('legal')).filter((entry) => !entry.data.draft);
  const entries = [...pageIds, ...policies.map((entry) => `legal/${entry.id}` as const)].flatMap(
    (page) =>
      uiLocales.map((locale) => {
        const links = alternates(page, site)
          .map(
            ({ hreflang, href }) =>
              `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>`,
          )
          .join('\n');
        return `  <url>\n    <loc>${absoluteUrl(pagePath(locale, page), site)}</loc>\n${links}\n  </url>`;
      }),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
