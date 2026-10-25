import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';
import { isLocale, setLocale } from './paraglide/runtime.js';

// Preserve the server's Accept-Language choice when there is no locale cookie yet.
const locale = document.documentElement.lang;
if (isLocale(locale)) setLocale(locale, { reload: false });

hydrateRoot(document, <StartClient />);
