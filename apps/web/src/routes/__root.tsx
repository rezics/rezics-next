import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import '../styles.css';

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'REZICS' }] }),
  component: Root,
  notFoundComponent: () => <main><h1>{m.not_found_heading()}</h1><p>{m.not_found_message()}</p></main>,
});
function Root() {
  return <html lang={getLocale()}><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>;
}
