import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { locales } from '../paraglide/runtime.js';
import { robotsResponse } from '../sitemap/robots';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: (() => {
      const respond = ({ request }: { request: Request }) =>
        robotsResponse(request, { origin: (env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN ?? '', locales })!;
      return { GET: respond, HEAD: respond, POST: respond };
    })(),
  },
});
