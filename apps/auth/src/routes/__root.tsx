import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { AuthShell } from '../frame';
import '../styles.css';

export const Route = createRootRoute({
  component: Root,
});

function Root() {
  useLayoutEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang={getLocale()}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href={import.meta.env.BASE_URL + 'rezics-mark.svg'} type="image/svg+xml" />
        <HeadContent />
      </head>
      <body>
        <AuthShell>
          <Outlet />
        </AuthShell>
        <Scripts />
      </body>
    </html>
  );
}
