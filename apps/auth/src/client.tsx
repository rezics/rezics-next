import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';
import { initializeDocumentLocale, restoreDocumentLocale } from './locale-observation';

// Preserve the server's Accept-Language choice when there is no locale cookie yet.
initializeDocumentLocale(document.documentElement.lang);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) restoreDocumentLocale();
});

hydrateRoot(document, <StartClient />, { onCaughtError: () => {} });
