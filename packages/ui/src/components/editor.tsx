'use client';

import type React from 'react';
import { cn } from '../utils.ts';

/**
 * A calm writing surface for long plain text: chapters, synopses and notes. It grows with the
 * text, sets the manuscript in the reading serif at a CJK-friendly 1.8 line height, and spaces
 * Han from Latin and digits. Give it `lang` and `dir` for the text's own language, not the
 * interface's.
 *
 * It is a native textarea on purpose. REZICS text drafts (`content-text-v1`) are plain text
 * with one paragraph per line, so a rich-text model would add a format Main cannot store, while
 * the native control keeps every script's IME composition, spellcheck, undo, mobile keyboards
 * and assistive technology intact. Handlers that react to typing should skip events whose
 * `nativeEvent.isComposing` is true and act on `compositionend` instead.
 */
export const Editor = ({ className, typeface = 'serif', ...props }: React.ComponentProps<'textarea'> & {
  /** The manuscript face; `sans` suits notes and scripts that read better without serifs. */
  typeface?: 'serif' | 'sans';
}) => (
  <textarea
    className={cn(
      'field-sizing-content block min-h-[60dvh] w-full resize-none',
      'bg-transparent px-0 py-2 text-foreground caret-primary',
      typeface === 'serif' ? 'font-work-title' : 'font-sans',
      'text-lg/[1.8] [text-autospace:normal] [overflow-wrap:anywhere]',
      'placeholder:text-muted-foreground/64',
      'rounded-none border-0 outline-none focus-visible:outline-none',
      'read-only:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-64',
      className,
    )}
    data-slot="editor"
    spellCheck
    {...props}
  />
);

/** A title line above an Editor: large, borderless and single-line. */
export const EditorTitle = ({ className, ...props }: React.ComponentProps<'input'>) => (
  <input
    className={cn(
      'block w-full bg-transparent px-0 py-1 font-semibold font-work-title text-3xl/tight tracking-tight',
      'text-foreground caret-primary [text-autospace:normal] placeholder:text-muted-foreground/64',
      'border-0 outline-none focus-visible:outline-none sm:text-4xl/tight',
      className,
    )}
    data-slot="editor-title"
    {...props}
  />
);

const ideographic = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Words and characters in a manuscript, as writers count them: a Han or kana character counts as
 * one word, and other scripts (space-separated Korean included) count word segments. Characters
 * are grapheme clusters without line breaks, so an emoji or a combined accent counts once.
 */
export function textStats(text: string, locale?: string): { words: number; characters: number } {
  const graphemes = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  let words = 0;
  let characters = 0;
  for (const part of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
    if (!part.isWordLike) continue;
    if (!ideographic.test(part.segment)) { words += 1; continue; }
    let other = false;
    for (const { segment } of graphemes.segment(part.segment)) {
      if (ideographic.test(segment)) words += 1;
      else other = true;
    }
    if (other) words += 1;
  }
  for (const { segment } of graphemes.segment(text)) {
    if (segment !== '\n' && segment !== '\r\n') characters += 1;
  }
  return { words, characters };
}

/** A quiet footer line for an Editor: counts and the save state sit here. */
export const EditorFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs tabular-nums', className)}
    data-slot="editor-footer"
    {...props}
  />
);
