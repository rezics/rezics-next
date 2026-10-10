'use client';

import { useEffect, useState } from 'react';
import { typeEntry } from '../catalogue/types.ts';
import { EpisodeProgress } from './episode-progress.tsx';
import type { EpisodeApi } from './episode-api.ts';
import { ChapterProgress } from './chapter-progress.tsx';
import { GameProgress } from './game-progress.tsx';
import type { MediaApi } from './media-api.ts';
import { WorkProgress } from './work-progress.tsx';
import type { Copy } from './messages.ts';

type Choice = { kind: 'game' | 'chapters' | 'episodes' } | { kind: 'work'; verb: 'play' | 'read' };

/**
 * The progress control for this Work. Parts use the control those parts already have. A Work with
 * no parts is one mark: not started, playing or reading, completed, or dropped. The kind comes from
 * the registry's presentation and from whether Main actually lists parts. The web keeps no type table.
 */
export function MediumProgress({ work, api, episodes, t, className }: {
  work: string; api: MediaApi; episodes: EpisodeApi | null; t: Copy; className?: string;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const types = await api.types(work);
      if (!types.ok && types.failure === 'missing') return;
      const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
      const next = await choose(api, episodes, work, presentation);
      if (current) setChoice(next);
    })();
    return () => { current = false; };
  }, [api, episodes, work]);
  if (!choice) return null;
  if (choice.kind === 'work') return <WorkProgress work={work} api={api} verb={choice.verb} t={t} className={className} />;
  if (choice.kind === 'game') return <GameProgress work={work} api={api} t={t} className={className} />;
  if (choice.kind === 'chapters') return <ChapterProgress work={work} api={api} t={t} className={className} />;
  if (episodes) return <EpisodeProgress work={work} api={episodes} t={t} className={className} />;
  return <WorkProgress work={work} api={api} verb="read" t={t} className={className} />;
}

/** Positive emptiness is a whole Work. A failed read stays with the part control, which says so. */
async function choose(api: MediaApi, episodes: EpisodeApi | null, work: string, presentation: string | null): Promise<Choice> {
  if (presentation === 'game') {
    const routes = await api.routes(work);
    if (!routes.ok || routes.data.items.length > 0 || routes.data.next) return { kind: 'game' };
    return { kind: 'work', verb: 'play' };
  }
  if (presentation === 'media' && episodes) {
    const structure = await episodes.structure(work);
    if (!structure.ok || (structure.data && !structure.data.placesWorks)) return { kind: 'episodes' };
  }
  const volumes = await api.volumes(work);
  if (!volumes.ok || volumes.data.length > 0) return { kind: 'chapters' };
  const chapters = await api.chapters(work);
  if (!chapters.ok || (chapters.data?.length ?? 0) > 0) return { kind: 'chapters' };
  return { kind: 'work', verb: 'read' };
}
