'use client';

import { Button } from '@rezics/ui/button';
import { Popover, PopoverBody, PopoverContent, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { CheckIcon, MinusIcon, PlusIcon, TypeIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { preferenceCookie } from '../shell/preferences.ts';
import { lineWidths, paragraphPosition, READER_COOKIE, type ReaderSettings,
  serializeReaderSettings, textSizes, typefaces } from './reader-settings.ts';
import type { ChapterRead, Progress } from './types.ts';

export interface SettingsLabels {
  settings: string; textSize: string; smallerText: string; largerText: string; lineWidth: string;
  narrow: string; medium: string; wide: string; typeface: string; serif: string; sans: string; settingsLocal: string;
}

function Choice({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <Button type="button" size="sm" variant={pressed ? 'soft' : 'ghost'} aria-pressed={pressed} onClick={onClick}>
    {children}</Button>;
}

/**
 * The reading column with its settings. The toolbar and the chapter come from
 * the server; the settings apply as CSS variables and persist in a cookie, so
 * the next page renders with them.
 */
export function ReaderSurface({ initial, labels, toolbar, children }: {
  initial: ReaderSettings; labels: SettingsLabels; toolbar: ReactNode; children: ReactNode;
}) {
  const [settings, setSettings] = useState(initial);
  const update = (next: Partial<ReaderSettings>) => {
    const value = { ...settings, ...next };
    setSettings(value);
    document.cookie = preferenceCookie(READER_COOKIE, encodeURIComponent(serializeReaderSettings(value)),
      location.protocol === 'https:');
  };
  const style = { '--reader-size': `${textSizes[settings.size]}px`,
    '--reader-width': `${lineWidths[settings.width]}rem` } as CSSProperties;
  return <div style={style} data-face={settings.face} className="group/reader grid gap-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {toolbar}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm"><TypeIcon aria-hidden="true" />{labels.settings}</Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <PopoverHeader title={labels.settings} description={labels.settingsLocal} />
          <PopoverBody className="grid gap-4 text-sm">
            <div className="grid gap-1.5">
              <p className="font-medium">{labels.textSize}</p>
              <div className="flex items-center gap-2">
                <Button type="button" size="icon-sm" variant="outline" aria-label={labels.smallerText}
                  disabled={settings.size === 0} onClick={() => update({ size: settings.size - 1 })}>
                  <MinusIcon aria-hidden="true" /></Button>
                <span className="min-w-12 text-center tabular-nums">{textSizes[settings.size]}px</span>
                <Button type="button" size="icon-sm" variant="outline" aria-label={labels.largerText}
                  disabled={settings.size === textSizes.length - 1} onClick={() => update({ size: settings.size + 1 })}>
                  <PlusIcon aria-hidden="true" /></Button>
              </div>
            </div>
            <div role="group" aria-label={labels.lineWidth} className="grid gap-1.5">
              <p aria-hidden="true" className="font-medium">{labels.lineWidth}</p>
              <div className="flex gap-1">
                {(Object.keys(lineWidths) as (keyof typeof lineWidths)[]).map(width =>
                  <Choice key={width} pressed={settings.width === width} onClick={() => update({ width })}>
                    {labels[width]}</Choice>)}
              </div>
            </div>
            <div role="group" aria-label={labels.typeface} className="grid gap-1.5">
              <p aria-hidden="true" className="font-medium">{labels.typeface}</p>
              <div className="flex gap-1">
                {typefaces.map(face => <Choice key={face} pressed={settings.face === face}
                  onClick={() => update({ face })}>{labels[face]}</Choice>)}
              </div>
            </div>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </div>
    {children}
  </div>;
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * ← and → move between chapters, mirrored for right-to-left text. Keys typed
 * into a field, pressed with a modifier or used by an input method composing
 * CJK text are left alone.
 */
export function ChapterKeys({ previous, next, direction }: {
  previous: string | null; next: string | null; direction: 'ltr' | 'rtl' | 'none';
}) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
        || event.shiftKey || editable(event.target)) return;
      const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      const target = event.key === forward ? next : event.key === back ? previous : null;
      if (!target) return;
      event.preventDefault();
      router.push(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, previous, next, direction]);
  return null;
}

export interface ProgressLabels {
  progress: string; markRead: string; chapterRead: string; markUnread: string; saving: string;
  progressFailed: string;
}

type Saved = Pick<Progress, 'completed' | 'position' | 'version'>;

/** The paragraph at the top of the reading area, as a stored position. */
function currentPosition(): string | null {
  const paragraphs = document.querySelectorAll<HTMLElement>('[data-paragraph]');
  for (const paragraph of paragraphs) {
    if (paragraph.getBoundingClientRect().bottom > 96) return paragraphPosition(Number(paragraph.dataset.paragraph));
  }
  return null;
}

/**
 * The reader's own progress in this chapter, kept by Main: mark the chapter
 * read or unread, and the paragraph reached is saved as the reader scrolls.
 * Writes carry the version they saw; a stale one is re-read once and retried.
 */
export function ReadingProgress({ target, actingSubject, initial, labels }: {
  target: ChapterRead['progress']; actingSubject: string; initial: Progress; labels: ProgressLabels;
}) {
  const [saved, setSaved] = useState<Saved>(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const queue = useRef(Promise.resolve());
  const latest = useRef<Saved>(initial);

  const write = useCallback((change: { completed?: boolean; position?: string | null }) => {
    queue.current = queue.current.then(async () => {
      const api = browserMainApi().v1.compositions({ id: target.composition.slice(-36) })
        .occurrences({ occurrence: target.occurrence.slice(-36) }).progress;
      const body = (base: Saved) => ({ actingSubject, selectedRevision: target.selectedRevision,
        expectedVersion: base.version, completed: change.completed ?? base.completed,
        position: change.position === undefined ? base.position : change.position });
      if (change.completed !== undefined) setState('saving');
      let response = await api.put(body(latest.current), { headers: { 'idempotency-key': crypto.randomUUID() } });
      if (response.error?.status === 409) {
        const fresh = await api.get({ query: { actingSubject, selectedRevision: target.selectedRevision } });
        if (fresh.data) {
          latest.current = fresh.data;
          response = await api.put(body(fresh.data), { headers: { 'idempotency-key': crypto.randomUUID() } });
        }
      }
      if (response.data) {
        latest.current = response.data;
        setSaved(response.data);
        setState('idle');
      } else setState('failed');
    }).catch(() => setState('failed'));
  }, [actingSubject, target]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const position = currentPosition();
        if (position && position !== latest.current.position) write({ position });
      }, 2000);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(timer); window.removeEventListener('scroll', onScroll); };
  }, [write]);

  return <div className="grid justify-items-start gap-2">
    <p className="font-medium text-sm">{labels.progress}</p>
    <div className="flex flex-wrap items-center gap-2">
      {saved.completed
        ? <>
          <span className="flex items-center gap-1.5 font-medium text-sm text-success-foreground">
            <CheckIcon aria-hidden="true" className="size-4" />{labels.chapterRead}</span>
          <Button type="button" size="sm" variant="ghost" disabled={state === 'saving'}
            onClick={() => write({ completed: false })}>{labels.markUnread}</Button>
        </>
        : <Button type="button" size="sm" variant="outline" disabled={state === 'saving'}
          onClick={() => write({ completed: true })}>
          <CheckIcon aria-hidden="true" />{state === 'saving' ? labels.saving : labels.markRead}</Button>}
    </div>
    <p role="status" className="text-destructive-foreground text-xs">
      {state === 'failed' ? labels.progressFailed : null}</p>
  </div>;
}
