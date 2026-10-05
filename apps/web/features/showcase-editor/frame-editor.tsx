'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CrosshairIcon, XIcon } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useId, useRef } from 'react';
import {
  type BackgroundRole, containRect, frameScale, initialFocal, moveRect, phoneView, type PixelRect, resizeFrame,
  type Size, snapFrame,
} from './frame.ts';
import type { EditorCopy } from './messages.ts';

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const corners: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const opposite: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };
type Drag = { mode: 'frame' | 'focal'; corner: Corner | null; x: number; y: number; frame: PixelRect; focal: PixelRect | null };

const percent = (rect: PixelRect, size: Size): CSSProperties => ({
  left: `${(rect.left / size.width) * 100}%`, top: `${(rect.top / size.height) * 100}%`,
  width: `${(rect.width / size.width) * 100}%`, height: `${(rect.height / size.height) * 100}%`,
});

/** The free rectangle between a fixed corner and the dragged one, never turned inside out. */
function stretch(start: PixelRect, corner: Corner, dx: number, dy: number, least = 1): PixelRect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  const x = west ? Math.min(start.left + dx, right - least) : Math.max(right + dx, start.left + least);
  const y = north ? Math.min(start.top + dy, bottom - least) : Math.max(bottom + dy, start.top + least);
  return west ? { left: x, width: right - x, ...(north ? { top: y, height: bottom - y } : { top: start.top, height: y - start.top }) }
    : { left: start.left, width: x - start.left, ...(north ? { top: y, height: bottom - y } : { top: start.top, height: y - start.top }) };
}

/**
 * Frames a background to its exact ratio and marks its focal area, on the whole original: the
 * frame moves and resizes only through admitted sizes, and the focal area stays inside it. When
 * phones would cut this art (landscape art without portrait art), the cut they make is drawn.
 */
export function FrameEditor({ src, size, role, frame, focal, onChange, showPhone, t, disabled = false }: {
  src: string; size: Size; role: BackgroundRole; frame: PixelRect; focal: PixelRect | null;
  onChange: (next: { frame: PixelRect; focal: PixelRect | null }) => void; showPhone: boolean; t: EditorCopy; disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const ids = useId();
  const image = { left: 0, top: 0, ...size };
  const scale = frameScale(role, size, frame);
  const phone = showPhone ? phoneView(frame, focal) : null;
  const leastFocal = Math.max(8, Math.round(Math.min(frame.width, frame.height) * 0.04));

  const change = (nextFrame: PixelRect, nextFocal: PixelRect | null) =>
    onChange({ frame: nextFrame, focal: nextFocal ? containRect(nextFocal, nextFrame) : null });

  function start(event: PointerEvent<HTMLElement>, mode: Drag['mode'], corner: Corner | null) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, corner, x: event.clientX, y: event.clientY, frame, focal };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    const width = box.current?.clientWidth;
    if (!current || !width) return;
    const ratio = size.width / width;
    const dx = (event.clientX - current.x) * ratio;
    const dy = (event.clientY - current.y) * ratio;
    if (current.mode === 'frame') {
      const next = current.corner
        ? snapFrame(role, size, stretch(current.frame, current.corner, dx, dy), opposite[current.corner])
        : moveRect(current.frame, dx, dy, image);
      change(next, current.focal);
    } else if (current.focal) {
      change(frame, current.corner ? stretch(current.focal, current.corner, dx, dy, leastFocal)
        : moveRect(current.focal, dx, dy, frame));
    }
  }
  const end = () => { drag.current = null; };

  function keys(event: KeyboardEvent<HTMLElement>, mode: Drag['mode']) {
    if (disabled) return;
    const step = Math.max(1, Math.round(Math.max(size.width, size.height) * (event.shiftKey ? 0.05 : 0.005)));
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const arrow = arrows[event.key];
    if (mode === 'frame') {
      const grow = event.key === '+' || event.key === '=' ? 1 : event.key === '-' || event.key === '_' ? -1 : 0;
      if (arrow) change(moveRect(frame, arrow[0], arrow[1], image), focal);
      else if (grow) {
        const by = Math.max(1, Math.round((scale.most - scale.least) / 20));
        change(resizeFrame(role, size, frame, Math.min(scale.most, Math.max(scale.least, scale.value + grow * by))), focal);
      } else return;
    } else {
      if (!focal || !arrow) return;
      change(frame, event.altKey ? { ...focal, width: Math.max(leastFocal, focal.width + arrow[0]), height: Math.max(leastFocal, focal.height + arrow[1]) }
        : moveRect(focal, arrow[0], arrow[1], frame));
    }
    event.preventDefault();
  }

  const handles = (mode: Drag['mode']) => corners.map(corner => <span key={corner} aria-hidden="true" data-corner={corner}
    onPointerDown={event => start(event, mode, corner)}
    className={cn('absolute size-6 touch-none', 'after:absolute after:inset-[7px] after:rounded-full after:border-2 after:border-white',
      mode === 'frame' ? 'after:bg-primary' : 'after:bg-amber-500',
      corner === 'nw' && '-top-3 -left-3 cursor-nwse-resize', corner === 'ne' && '-top-3 -right-3 cursor-nesw-resize',
      corner === 'sw' && '-bottom-3 -left-3 cursor-nesw-resize', corner === 'se' && '-right-3 -bottom-3 cursor-nwse-resize',
      disabled && 'hidden')} />);

  return <div className="grid gap-3">
    <div ref={box} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      className="relative mx-auto touch-none select-none overflow-hidden rounded-xl bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-size-[16px_16px]"
      style={{ aspectRatio: `${size.width} / ${size.height}`, width: `min(100%, calc(22rem * ${size.width / size.height}))` }}>
      <img src={src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
      <div role="group" tabIndex={disabled ? -1 : 0} aria-label={t.frameLabel({ width: String(frame.width), height: String(frame.height) })}
        aria-describedby={`${ids}-frame-keys`} onKeyDown={event => keys(event, 'frame')}
        onPointerDown={event => start(event, 'frame', null)}
        className={cn('absolute cursor-move outline-none ring-offset-2 focus-visible:ring-3 focus-visible:ring-ring',
          'shadow-[0_0_0_9999px_rgb(7_16_29/0.62)] outline-2 outline-white -outline-offset-1', disabled && 'cursor-default')}
        style={percent(frame, size)}>
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,transparent_33.2%,#fff6_33.3%,transparent_33.4%,transparent_66.6%,#fff6_66.7%,transparent_66.8%),linear-gradient(to_bottom,transparent_33.2%,#fff6_33.3%,transparent_33.4%,transparent_66.6%,#fff6_66.7%,transparent_66.8%)]" />
        {handles('frame')}
      </div>
      {phone?.kind === 'cut' ? <div aria-hidden="true" style={percent(phone.window, size)}
        className="pointer-events-none absolute border-2 border-white/90 border-dashed">
        <span className="absolute top-1 start-1 rounded bg-black/70 px-1.5 py-0.5 font-medium text-[11px] text-white">{t.phoneWindow}</span>
      </div> : null}
      {focal ? <div role="group" tabIndex={disabled ? -1 : 0}
        aria-label={t.focalLabel({ width: String(focal.width), height: String(focal.height) })}
        aria-describedby={`${ids}-focal-keys`} onKeyDown={event => keys(event, 'focal')}
        onPointerDown={event => start(event, 'focal', null)} style={percent(focal, size)}
        className={cn('absolute cursor-move rounded-sm border-2 border-amber-400 bg-amber-300/15 outline-none',
          'shadow-[0_0_0_1px_rgb(0_0_0/0.5)] focus-visible:ring-3 focus-visible:ring-ring', disabled && 'cursor-default')}>
        <CrosshairIcon aria-hidden="true" className="-translate-1/2 pointer-events-none absolute top-1/2 left-1/2 size-4 text-amber-300 drop-shadow" />
        {handles('focal')}
      </div> : null}
    </div>
    <p id={`${ids}-frame-keys`} className="sr-only">{t.frameKeys}</p>
    <p id={`${ids}-focal-keys`} className="sr-only">{t.focalKeys}</p>
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <label className="grid gap-1.5 text-sm">
        <span className="flex justify-between gap-3"><span className="font-medium">{t.frameSize}</span>
          <span className="text-muted-foreground tabular-nums">{t.pixels({ width: String(frame.width), height: String(frame.height) })}</span></span>
        <input type="range" min={scale.least} max={scale.most} step={1} value={scale.value} disabled={disabled || scale.least === scale.most}
          onChange={event => change(resizeFrame(role, size, frame, Number(event.target.value)), focal)}
          aria-valuetext={t.pixels({ width: String(frame.width), height: String(frame.height) })}
          className="h-6 w-full cursor-pointer accent-primary disabled:cursor-default" />
      </label>
      {focal ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => change(frame, null)}>
        <XIcon aria-hidden="true" />{t.clearFocal}</Button>
        : <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => change(frame, initialFocal(frame))}>
          <CrosshairIcon aria-hidden="true" />{t.markFocal}</Button>}
    </div>
  </div>;
}
