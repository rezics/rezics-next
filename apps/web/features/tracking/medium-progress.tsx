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
 * no parts is one mark: not started, playing or reading, completed, or dropped. A book is chapters
 * even when its composition is empty or the first page is only volume groups. Anything else asks
 * the progress read whether the Work has parts. The web keeps no type table and does not guess
 * from a page of contents.
 */
export function MediumProgress({ work, api, episodes, t, className }: {
  work: string; api: MediaApi; episodes: EpisodeApi | null; t: Copy; className?: string;
}) {
  const [selected, setSelected] = useState<{ work: string; api: MediaApi; episodes: EpisodeApi | null; choice: Choice } | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const types = await api.types(work);
      if (!types.ok && types.failure === 'missing') return;
      const presentation = types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null;
      const next = await progressControl(api, episodes, work, presentation);
      if (current) setSelected({ work, api, episodes, choice: next });
    })();
    return () => { current = false; };
  }, [api, episodes, work]);
  const choice = selected?.work === work && selected.api === api && selected.episodes === episodes ? selected.choice : null;
  if (!choice) return null;
  if (choice.kind === 'work') return <WorkProgress work={work} api={api} verb={choice.verb} t={t} className={className} />;
  if (choice.kind === 'game') return <GameProgress work={work} api={api} t={t} className={className} />;
  if (choice.kind === 'chapters') return <ChapterProgress work={work} api={api} t={t} className={className} />;
  if (episodes) return <EpisodeProgress work={work} api={episodes} t={t} className={className} />;
  return <WorkProgress work={work} api={api} verb="read" t={t} className={className} />;
}

/** A book is chapters. A failed parts read stays with that control, which says so. */
export async function progressControl(api: Pick<MediaApi, 'routes' | 'workParts'>, episodes: Pick<EpisodeApi, 'structure'> | null,
  work: string, presentation: string | null): Promise<Choice> {
  if (presentation === 'book') return { kind: 'chapters' };
  if (presentation === 'game') {
    const routes = await api.routes(work);
    if (!routes.ok || routes.data.items.length > 0 || routes.data.next) return { kind: 'game' };
    return { kind: 'work', verb: 'play' };
  }
  if (presentation === 'media' && episodes) {
    const structure = await episodes.structure(work);
    if (!structure.ok || (structure.data && !structure.data.placesWorks)) return { kind: 'episodes' };
  }
  const parts = await api.workParts(work);
  if (!parts.ok || parts.data) return { kind: 'chapters' };
  return { kind: 'work', verb: 'read' };
}
