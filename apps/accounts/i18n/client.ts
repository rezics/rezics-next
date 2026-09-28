'use client';

import { create } from 'native-i18n/react/client';
import type { resources } from './resources.ts';

// The server chooses the locale and supplies every namespace used by the page.
// Hydration must use that snapshot, including in nested admin providers, without
// resolving browser languages or suspending on a second catalog load.
export const { TranslationProvider, useTranslation, useLocale } = create<typeof resources>();
