'use client';

import { useEffect, useState } from 'react';
import { typeEntry } from '../catalogue/types.ts';
import { EpisodeProgress } from './episode-progress.tsx';
import type { EpisodeApi } from './episode-api.ts';
import { ChapterProgress } from './chapter-progress.tsx';
import { GameProgress } from './game-progress.tsx';
import type { MediaApi } from './media-api.ts';
import { type Medium, mediumOf } from './media.ts';
import type { Copy } from './messages.ts';

/**
 * The progress control for this Work: episodes, chapters or a game, from the kind the registry
 * gives its types and from the structure Main returns. The web keeps no table of types.
 */
export function MediumProgress({ work, api, episodes, t, className }: {
  work: string; api: MediaApi; episodes: EpisodeApi | null; t: Copy; className?: string;
}) {
  const [medium, setMedium] = useState<Medium | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const types = await api.types(work);
      const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
      if (presentation === 'game' || presentation === 'media' || presentation === 'book') {
        if (current) setMedium(mediumOf(presentation, { volumes: false, chapters: false }));
        return;
      }
      const volumes = await api.volumes(work);
      const chapters = volumes.ok && volumes.data.length ? null : await api.chapters(work);
      if (!current) return;
      setMedium(mediumOf(presentation, {
        volumes: Boolean(volumes.ok && volumes.data.length),
        chapters: Boolean(chapters?.ok && chapters.data?.length),
      }));
    })();
    return () => { current = false; };
  }, [api, work]);
  if (medium === 'game') return <GameProgress work={work} api={api} t={t} className={className} />;
  if (medium === 'chapters') return <ChapterProgress work={work} api={api} t={t} className={className} />;
  if (medium === 'episodes' && episodes) return <EpisodeProgress work={work} api={episodes} t={t} className={className} />;
  return null;
}
