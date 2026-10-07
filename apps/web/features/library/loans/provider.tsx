'use client';

import { createContext, type ReactNode, use, useState } from 'react';
import { useLibrary } from '../library-context.tsx';
import { mainCopiesApi, type CopiesApi } from './api.ts';

const CopiesApiContext = createContext<CopiesApi | null>(null);

/** Stories pass an in-memory API; the library page uses Main. The first one stays for this view. */
export function CopiesApiProvider({ api, children }: { api?: CopiesApi; children: ReactNode }) {
  const { actingSubject } = useLibrary();
  const [own] = useState(() => api ?? mainCopiesApi(actingSubject));
  return <CopiesApiContext value={own}>{children}</CopiesApiContext>;
}

export function useCopiesApi(): CopiesApi {
  const api = use(CopiesApiContext);
  if (!api) throw new Error('useCopiesApi needs a CopiesApiProvider');
  return api;
}
