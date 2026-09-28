'use client';

import { Button } from '@rezics/ui/button';
import { Popover, PopoverBody, PopoverContent, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { CheckIcon, MinusIcon, PlusIcon, TypeIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { preferenceCookie } from '../shell/preferences.ts';
import { completeReaderSettings, lineWidths, paragraphPosition, READER_COOKIE, type CompleteReaderSettings,
  type ReaderSettings,
  serializeReaderSettings, textSizes, typefaces } from './reader-settings.ts';
import type { ChapterRead, Progress } from './types.ts';

export interface SettingsLabels {
  settings: string; textSize: string; smallerText: string; largerText: string; lineWidth: string;
  narrow: string; medium: string; wide: string; typeface: string; serif: string; sans: string; settingsLocal: string;
  paragraphIndent: string; theme: string; system: string; light: string; dark: string;
  cjkSpacing: string; cjkAuto: string; cjkNone: string; cjkPunctuation: string;
  cjkStandard: string; cjkStrict: string; settingsFailed: string;
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
export function ReaderSurface({ initial, actingSubject, labels, toolbar, children }: {
  initial: ReaderSettings; actingSubject: string | null; labels: SettingsLabels;
  toolbar: ReactNode; children: ReactNode;
}) {
  const [settings, setSettings] = useState(() => completeReaderSettings(initial));
  const [syncFailed, setSyncFailed] = useState(false);
  const latest = useRef(completeReaderSettings(initial));
  const version = useRef<number | null>(null);
  const edited = useRef(false);
  const pending = useRef<Partial<CompleteReaderSettings>>({});
  const ready = useRef(Promise.resolve());
  const queue = useRef(Promise.resolve());
  const persist = (value: CompleteReaderSettings) => {
    latest.current = value;
    setSettings(value);
    document.cookie = preferenceCookie(READER_COOKIE, encodeURIComponent(serializeReaderSettings(value)),
      location.protocol === 'https:');
  };
  const payload = (value: CompleteReaderSettings, expectedVersion: number) => ({
    actingSubject: actingSubject!, expectedVersion, fontSize: textSizes[value.size],
    lineWidth: value.width, typeface: value.face, paragraphIndent: value.indent,
    theme: value.theme, cjkSpacing: value.cjkSpacing, cjkPunctuation: value.cjkPunctuation,
  });
  const fromRemote = (value: { fontSize: number; lineWidth: ReaderSettings['width'];
    typeface: ReaderSettings['face']; paragraphIndent: boolean; theme: CompleteReaderSettings['theme'];
    cjkSpacing: CompleteReaderSettings['cjkSpacing']; cjkPunctuation: CompleteReaderSettings['cjkPunctuation'] }) =>
    ({ size: Math.max(0, textSizes.indexOf(value.fontSize as typeof textSizes[number])),
      width: value.lineWidth, face: value.typeface, indent: value.paragraphIndent,
      theme: value.theme, cjkSpacing: value.cjkSpacing,
      cjkPunctuation: value.cjkPunctuation });
  useEffect(() => {
    if (!actingSubject) return;
    let active = true;
    ready.current = (async () => {
      try {
        const response = await browserMainApi().v1.reader.settings.get({ query: { actingSubject } });
        if (!active || !response.data) { if (active) setSyncFailed(true); return; }
        version.current = response.data.version;
        if (response.data.version > 0) persist({ ...fromRemote(response.data), ...pending.current });
        else if (!edited.current && JSON.stringify(latest.current)
          !== JSON.stringify(completeReaderSettings({ size: 1, width: 'medium', face: 'serif' }))) {
          const seeded = await browserMainApi().v1.reader.settings.put(payload(latest.current, 0),
            { headers: { 'idempotency-key': crypto.randomUUID() } });
          if (seeded.data) version.current = seeded.data.version;
          else setSyncFailed(true);
        }
      } catch { if (active) setSyncFailed(true); }
    })();
    return () => { active = false; };
  }, [actingSubject]);
  useEffect(() => {
    const root = document.documentElement;
    const previous = { light: root.classList.contains('light'), dark: root.classList.contains('dark') };
    if (settings.theme !== 'system') {
      root.classList.remove('light', 'dark');
      root.classList.add(settings.theme);
    }
    return () => {
      root.classList.remove('light', 'dark');
      if (previous.light) root.classList.add('light');
      if (previous.dark) root.classList.add('dark');
    };
  }, [settings.theme]);
  const update = (next: Partial<CompleteReaderSettings>) => {
    const value = { ...latest.current, ...next };
    edited.current = true;
    pending.current = { ...pending.current, ...next };
    persist(value);
    if (!actingSubject) return;
    queue.current = queue.current.then(async () => {
      await ready.current;
      const api = browserMainApi().v1.reader.settings;
      if (version.current === null) {
        const fresh = await api.get({ query: { actingSubject } });
        if (fresh.data) version.current = fresh.data.version;
        else { setSyncFailed(true); return; }
      }
      let response = await api.put(payload(latest.current, version.current),
        { headers: { 'idempotency-key': crypto.randomUUID() } });
      if (response.error?.status === 409) {
        const fresh = await api.get({ query: { actingSubject } });
        if (fresh.data) {
          version.current = fresh.data.version;
          response = await api.put(payload(latest.current, fresh.data.version),
            { headers: { 'idempotency-key': crypto.randomUUID() } });
        }
      }
      if (response.data) { version.current = response.data.version; setSyncFailed(false); }
      else setSyncFailed(true);
    }).catch(() => setSyncFailed(true));
  };
  const style = { '--reader-size': `${textSizes[settings.size]}px`,
    '--reader-width': `${lineWidths[settings.width]}rem` } as CSSProperties;
  return <div style={style} data-face={settings.face} data-indent={settings.indent}
    data-cjk-spacing={settings.cjkSpacing} data-cjk-punctuation={settings.cjkPunctuation}
    className="group/reader grid gap-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {toolbar}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm"><TypeIcon aria-hidden="true" />{labels.settings}</Button>
        </PopoverTrigger>
        <PopoverContent className="max-h-[min(80dvh,40rem)] w-72 overflow-y-auto">
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
            <div role="group" aria-label={labels.paragraphIndent} className="grid gap-1.5">
              <Choice pressed={settings.indent} onClick={() => update({ indent: !settings.indent })}>
                {labels.paragraphIndent}</Choice>
            </div>
            <div role="group" aria-label={labels.theme} className="grid gap-1.5">
              <p aria-hidden="true" className="font-medium">{labels.theme}</p>
              <div className="flex gap-1">{(['system', 'light', 'dark'] as const).map(theme =>
                <Choice key={theme} pressed={settings.theme === theme} onClick={() => update({ theme })}>
                  {labels[theme]}</Choice>)}</div>
            </div>
            <div role="group" aria-label={labels.cjkSpacing} className="grid gap-1.5">
              <p aria-hidden="true" className="font-medium">{labels.cjkSpacing}</p>
              <div className="flex gap-1">
                <Choice pressed={settings.cjkSpacing === 'auto'} onClick={() => update({ cjkSpacing: 'auto' })}>
                  {labels.cjkAuto}</Choice>
                <Choice pressed={settings.cjkSpacing === 'none'} onClick={() => update({ cjkSpacing: 'none' })}>
                  {labels.cjkNone}</Choice>
              </div>
            </div>
            <div role="group" aria-label={labels.cjkPunctuation} className="grid gap-1.5">
              <p aria-hidden="true" className="font-medium">{labels.cjkPunctuation}</p>
              <div className="flex gap-1">
                <Choice pressed={settings.cjkPunctuation === 'standard'}
                  onClick={() => update({ cjkPunctuation: 'standard' })}>{labels.cjkStandard}</Choice>
                <Choice pressed={settings.cjkPunctuation === 'strict'}
                  onClick={() => update({ cjkPunctuation: 'strict' })}>{labels.cjkStrict}</Choice>
              </div>
            </div>
            {syncFailed ? <p role="status" className="text-destructive-foreground text-xs">
              {labels.settingsFailed}</p> : null}
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </div>
    {children}
  </div>;
}

/** Whether a tap on the page is meant for the text rather than a control or a selection. */
function tapsText(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-reader-text]') !== null
    && target.closest('a, button, input, select, textarea, [role="button"]') === null
    && !window.getSelection()?.toString();
}

/**
 * While reading on a phone, the site's header and tab bar step aside as the
 * reader scrolls down and come back when they scroll up or reach the end, as
 * e-book apps do; a tap on the text shows or hides them, so a short chapter
 * can be read without them too. Keyboard focus outside the text brings them
 * back. The shell hides them for `html[data-reading=hidden]` on narrow screens.
 */
export function ReaderChrome() {
  useEffect(() => {
    const root = document.documentElement;
    let last = window.scrollY;
    root.dataset.reading = 'shown';
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - last) < 8) return;
      const end = window.innerHeight + y >= document.documentElement.scrollHeight - 48;
      root.dataset.reading = y > last && y > 64 && !end ? 'hidden' : 'shown';
      last = y;
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !tapsText(event.target)) return;
      root.dataset.reading = root.dataset.reading === 'hidden' ? 'shown' : 'hidden';
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-reader-text]')) root.dataset.reading = 'shown';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', onClick);
      document.removeEventListener('focusin', onFocus);
      delete root.dataset.reading;
    };
  }, []);
  return null;
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
