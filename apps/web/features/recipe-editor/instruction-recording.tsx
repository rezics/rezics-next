'use client';

import { Button } from '@rezics/ui/button';
import { useMediaImagePresentation } from '@rezics/ui/media-image';
import { useEffect, useRef, useState } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import type { Instruction } from './instructions.ts';

/** Bytes are requested only after the viewer opens the exact Use, with the existing media policy. */
export function InstructionRecording({ instruction, messages: t, fetcher = fetch }: {
  instruction: Instruction; messages: WorkPageMessages; fetcher?: typeof fetch;
}) {
  const recording = instruction.details?.recording;
  const selector = instruction.reference.selector;
  const query = new URLSearchParams({ ...(instruction.mediaUse ? { use: instruction.mediaUse } : {}),
    ...(instruction.details?.actingSubject ? { actingSubject: instruction.details.actingSubject } : {}) });
  const href = selector.grain === 'representation' ? `${BFF_PREFIX}/v1/media/representations/${selector.representation}/bytes?${query}` : undefined;
  const policy = useMediaImagePresentation(href, { metadata: recording ? {
    representationId: recording.representation, ...(recording.use ? { mediaUseId: recording.use } : {}),
    src: href!, nsfw: recording.nsfw, ageRating: recording.ageRating, conceal: recording.conceal,
  } : undefined });
  const [state, setState] = useState<{ kind: 'idle' | 'loading' } | { kind: 'ready'; src: string }
    | { kind: 'failed'; status?: number; problem?: unknown }>({ kind: 'idle' });
  const live = useRef(true);
  const objectUrl = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setState({ kind: 'idle' });
  }, [policy.presentation]);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); };
  }, []);
  const open = async () => {
    if (!recording || !href || state.kind === 'loading') return;
    setState({ kind: 'loading' });
    const openedGeneration = generation.current;
    const current = () => live.current && openedGeneration === generation.current;
    try {
      const response = await fetcher(new URL(href, window.location.origin), {
        credentials: instruction.details?.actingSubject ? 'same-origin' : 'omit', cache: 'no-store',
      });
      if (!response.ok) {
        const problem: unknown = await response.json().catch(() => null);
        if (current()) setState({ kind: 'failed', status: response.status, problem });
        return;
      }
      const bytes = await response.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (sha256 !== recording.sha256) throw new Error('Recording byte integrity mismatch');
      if (!current()) return;
      const src = URL.createObjectURL(new Blob([bytes], { type: recording.mediaType }));
      objectUrl.current = src;
      setState({ kind: 'ready', src: `${src}${selector.grain === 'representation' && selector.fragment ? `#${selector.fragment}` : ''}` });
    } catch {
      if (current()) setState({ kind: 'failed' });
    }
  };
  if (!recording || policy.presentation === 'unavailable' || policy.presentation === 'rating-hidden')
    return <p role="status">{t.contentsUnavailable}</p>;
  if (policy.presentation === 'loading') return <p role="status">{t.loadingRegion}</p>;
  return <div className="grid min-w-0 gap-2">
    {state.kind === 'ready' ? recording.mediaType.startsWith('video/')
      ? <video controls preload="metadata" src={state.src} aria-label={t.openRecording} className="w-full" />
      : <audio controls preload="metadata" src={state.src} aria-label={t.openRecording} className="w-full" />
      : <>
        {policy.presentation === 'masked' ? <p className="text-sm text-muted-foreground">{t.recordingMasked}</p> : null}
        <Button type="button" variant="outline" className="min-h-11 justify-self-start" disabled={state.kind === 'loading'}
          onClick={() => void open()}>{state.kind === 'loading' ? t.loadingRegion : t.openRecording}</Button>
      </>}
    {state.kind === 'failed' ? <p role="alert" data-status={state.status}>{t.contentsUnavailable}{state.status ? ` (${state.status})` : ''}</p> : null}
  </div>;
}
