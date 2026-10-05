'use client';

import { imagePresentation, type ImageAgeRating, type MediaImageViewer } from '@rezics/ui/media-image';
import { Button } from '@rezics/ui/button';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { contentRatingTarget, readContentRatings, type ContentRatingRead, type ContentRatings } from '../api/content-rating.ts';
import { mediaMessages } from './media-messages.ts';

type Resolver = (targets: string[]) => Promise<ContentRatings>;
interface RatingContext {
  viewer: MediaImageViewer;
  locale: UiLocale;
  ratings: ContentRatings;
  mount: (target: string) => () => void;
  retry: (target: string) => void;
}
const RatingContext = createContext<RatingContext | null>(null);
const emptyRatings: ContentRatings = {};

/** Only mounted bodies request assessments. Repeated targets share a cache and each transport batch is bounded. */
export function WebRatedContentProvider({ viewer, actingSubject, locale, children, resolve, refreshKey }: {
  viewer: MediaImageViewer; actingSubject?: string | null; locale: UiLocale; children: ReactNode;
  resolve?: Resolver;
  refreshKey?: string | number;
}) {
  const [loaded, setLoaded] = useState<{ generation: number; ratings: Record<string, ImageAgeRating | null>;
    viewer: MediaImageViewer | null }>({ generation: 0, ratings: {}, viewer: null });
  const mounted = useRef(new Map<string, number>());
  const requested = useRef(new Set<string>());
  const scheduled = useRef(false);
  const live = useRef(true);
  const generation = useRef({ key: refreshKey, actor: actingSubject, number: 0 });
  if (!Object.is(generation.current.key, refreshKey) || generation.current.actor !== actingSubject) {
    generation.current = { key: refreshKey, actor: actingSubject, number: generation.current.number + 1 };
    requested.current.clear(); scheduled.current = false;
  }
  const currentGeneration = generation.current.number;
  const ratings = loaded.generation === currentGeneration ? loaded.ratings : emptyRatings;
  const resolver = useRef<(targets: string[]) => Promise<ContentRatingRead>>(targets => readContentRatings(targets, actingSubject));
  resolver.current = resolve ? async targets => ({ ratings: await resolve(targets), viewer: null })
    : targets => readContentRatings(targets, actingSubject);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const schedule = useCallback(() => {
    if (!scheduled.current) {
      scheduled.current = true;
      queueMicrotask(() => {
        if (!live.current || generation.current.number !== currentGeneration) return;
        scheduled.current = false;
        const targets = [...mounted.current.keys()].filter(item => !requested.current.has(item));
        for (let offset = 0; offset < targets.length; offset += 64) {
          const batch = targets.slice(offset, offset + 64);
          batch.forEach(item => requested.current.add(item));
          void resolver.current(batch).then(result => {
            if (live.current && generation.current.number === currentGeneration) setLoaded(prior => ({ generation: currentGeneration,
              viewer: result.viewer ?? (prior.generation === currentGeneration ? prior.viewer : null),
              ratings: { ...(prior.generation === currentGeneration ? prior.ratings : {}),
                ...Object.fromEntries(batch.map(item => [item, result.ratings[item] ?? null])) } }));
          }).catch(() => {
            if (live.current && generation.current.number === currentGeneration) setLoaded(prior => ({ generation: currentGeneration,
              viewer: prior.generation === currentGeneration ? prior.viewer : null,
              ratings: { ...(prior.generation === currentGeneration ? prior.ratings : {}),
                ...Object.fromEntries(batch.map(item => [item, null])) } }));
          });
        }
      });
    }
  }, [currentGeneration]);
  const mount = useCallback((target: string) => {
    mounted.current.set(target, (mounted.current.get(target) ?? 0) + 1);
    if (!requested.current.has(target)) schedule();
    return () => {
      const count = mounted.current.get(target) ?? 0;
      if (count > 1) mounted.current.set(target, count - 1);
      else mounted.current.delete(target);
    };
  }, [schedule]);
  const retry = useCallback((target: string) => {
    if (!mounted.current.has(target)) return;
    requested.current.delete(target);
    setLoaded(prior => {
      const next = prior.generation === currentGeneration ? { ...prior.ratings } : {};
      delete next[target];
      return { generation: currentGeneration, ratings: next,
        viewer: prior.generation === currentGeneration ? prior.viewer : null };
    });
    schedule();
  }, [currentGeneration, schedule]);
  // Main supplies current Account-derived viewing evidence in the same suitability read.
  // It can recover the text gate when the separate Account session-cookie read is unavailable.
  const viewing = loaded.generation === currentGeneration && loaded.viewer ? loaded.viewer : viewer;
  const context = useMemo(() => ({ viewer: viewing, locale, ratings, mount, retry }), [viewing, locale, ratings, mount, retry]);
  return <RatingContext.Provider value={context}>{children}</RatingContext.Provider>;
}

export function WebRatedContent({ target, children, className }: {
  target?: string | null; children: ReactNode; className?: string;
}) {
  const context = useContext(RatingContext);
  const mount = context?.mount;
  const valid = Boolean(target && contentRatingTarget(target));
  useEffect(() => valid && target && mount ? mount(target) : undefined, [target, valid, mount]);
  // Standalone component previews have no service adapter; the Web layout mounts this provider.
  if (!target || !context) return <>{children}</>;
  const labels = mediaMessages[context?.locale ?? 'en'];
  const rating = context?.ratings[target];
  // Missing/malformed assessments and transport failures are failed lookups, not unavailable text.
  // Keep the body gated until a valid assessment arrives; retry never overrides age/preferences.
  const state = !valid ? 'unavailable' : rating === null || rating !== undefined && !context.viewer.ready ? 'failed'
    : rating === undefined ? 'loading' : imagePresentation({ nsfw: 'sfw', ageRating: rating }, context.viewer);
  if (state === 'visible') return <>{children}</>;
  if (state === 'failed') return <div role="status"
    className={className ?? 'grid gap-3 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground'}>
    <p>{labels.ratingFailed}</p>
    <Button size="sm" variant="outline" className="justify-self-start" onClick={() => context.retry(target)}>
      {labels.retryRating}
    </Button>
  </div>;
  return <div role="status" className={className ?? 'rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground'}>
    {state === 'loading' ? labels.loading : state === 'rating-hidden' ? labels.ratingHidden : labels.unavailable}
  </div>;
}
