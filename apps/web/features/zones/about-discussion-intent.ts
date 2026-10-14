import type { AboutPostIntent } from './about-discussion-api.ts';
import { parseLanguage } from '@rezics/main/language';

/** Device state belongs to one author and route. Never substitute today's basis during replay. */
export function retainedAboutPost(raw: string, actor: string, zone: string, path: string): AboutPostIntent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const saved = value as Partial<AboutPostIntent>;
    const basis = saved.basis;
    if (saved.actingSubject !== actor || !basis || basis.zone !== zone || basis.path !== path
      || typeof saved.key !== 'string' || !/^[A-Za-z0-9:_./-]{1,128}$/.test(saved.key)
      || typeof saved.body !== 'string' || !saved.body.trim() || new TextEncoder().encode(saved.body).length > 8192
      || typeof saved.language !== 'string' || saved.language.length > 35
      || !parseLanguage(saved.language) || typeof saved.spoiler !== 'boolean'
      || !['realm', 'about', 'targetRevision', 'zone', 'routeRevision'].every(key =>
        /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(basis[key as keyof typeof basis]))) return null;
    return { key: saved.key, basis: { ...basis }, actingSubject: actor,
      body: saved.body, language: saved.language, spoiler: saved.spoiler };
  } catch { return null; }
}

/** Convert a site address to Main's live Zone route. `spaceRef` is safe to spread into JSX; React reserves `ref`. */
export function aboutDiscussionAddress(href: string): { spaceRef: string; path: string } | null {
  const segments = href.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (segments[0] !== 'z' || !segments[1]) return null;
  return { spaceRef: segments[1], path: `/${segments.slice(2).join('/')}` };
}
