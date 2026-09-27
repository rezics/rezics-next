'use client';

import { create } from 'native-i18n/react/client';
import { resources } from './resources.ts';

export const { TranslationProvider, useTranslation, useLocale } = create(resources);
