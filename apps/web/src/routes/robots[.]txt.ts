import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { locales } from '../paraglide/runtime.js';
import { robotsResponse } from '../sitemap/robots';

const respond = ({ request }: { request: Request }) =>
  robotsResponse(request, { origin: (env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN ?? '', locales })!;

export const Route = createFileRoute('/robots.txt')({
  server: { handlers: { GET: respond, HEAD: respond, POST: respond } },
});
