import type { APIRoute } from 'astro';
import { absoluteUrl } from '../lib/site.ts';

export const GET: APIRoute = ({ site }) =>
  new Response(
    `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${absoluteUrl('/sitemap.xml', site)}\n`,
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
