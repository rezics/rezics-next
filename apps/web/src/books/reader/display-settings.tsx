import { useEffect, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import './display-settings.css';

export const bookDisplayStorageKey = 'rezics.book-reader.display.v1';
export const bookTextSizes = [12, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 28, 30, 32] as const;
export type BookDisplay = {
  size: number;
  width: 'narrow' | 'standard' | 'wide';
  face: 'sans' | 'serif';
  indent: boolean;
  spacing: 'auto' | 'none';
  punctuation: 'standard' | 'strict';
};
export const defaultBookDisplay: Readonly<BookDisplay> = {
  size: 17,
  width: 'standard',
  face: 'sans',
  indent: false,
  spacing: 'auto',
  punctuation: 'standard',
};

/** Display choices only: no document, chapter coordinates, identity or private reading state. */
export function parseBookDisplay(value: string | null): BookDisplay {
  if (!value || value.length > 256) return { ...defaultBookDisplay };
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...defaultBookDisplay };
    const row = data as Record<string, unknown>;
    if (row.version !== 1) return { ...defaultBookDisplay };
    return {
      size: bookTextSizes.some((size) => row.size === size) ? (row.size as number) : defaultBookDisplay.size,
      width: row.width === 'narrow' || row.width === 'wide' ? row.width : 'standard',
      face: row.face === 'serif' ? 'serif' : 'sans',
      indent: row.indent === true,
      spacing: row.spacing === 'none' ? 'none' : 'auto',
      punctuation: row.punctuation === 'strict' ? 'strict' : 'standard',
    };
  } catch {
    return { ...defaultBookDisplay };
  }
}

export function useBookDisplay() {
  const [display, setDisplay] = useState<BookDisplay>(() => ({ ...defaultBookDisplay }));
  const [storageAvailable, setStorageAvailable] = useState(true);
  useEffect(() => {
    try {
      setDisplay(parseBookDisplay(window.localStorage.getItem(bookDisplayStorageKey)));
    } catch {
      setStorageAvailable(false);
    }
  }, []);
  const change = (patch: Partial<BookDisplay>) => {
    const next = { ...display, ...patch };
    setDisplay(next);
    try {
      window.localStorage.setItem(bookDisplayStorageKey, JSON.stringify({ version: 1, ...next }));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  };
  return { display, change, storageAvailable };
}

type DisplayOwner = ReturnType<typeof useBookDisplay>;
const control = 'min-h-11 min-w-11 whitespace-normal';

export function BookDisplaySettings({ display, change, storageAvailable, locale }: DisplayOwner & { locale: string }) {
  const options = { locale: locale as never };
  const index = bookTextSizes.indexOf(display.size as (typeof bookTextSizes)[number]);
  const group = <Key extends 'width' | 'face' | 'spacing' | 'punctuation'>(
    key: Key,
    label: string,
    choices: readonly (readonly [BookDisplay[Key], string])[],
  ) => (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1">
        {choices.map(([value, title]) => (
          <Button
            key={value}
            type="button"
            variant={display[key] === value ? 'secondary' : 'outline'}
            className={control}
            aria-pressed={display[key] === value}
            onClick={() => change({ ...display, [key]: value })}
          >
            {title}
          </Button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <details data-slot="book-display-settings" className="group/display min-w-0 border-b pb-3">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        {m.book_reader_display_settings({}, options)}
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open/display:rotate-180" />
      </summary>
      <div className="grid min-w-0 gap-5 pt-4 sm:grid-cols-2">
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">{m.book_reader_display_size({}, options)}</legend>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={index <= 0}
              aria-label={m.book_reader_display_smaller({}, options)}
              onClick={() => change({ size: bookTextSizes[index - 1]! })}
            >
              <Minus aria-hidden="true" />
            </Button>
            <output className="min-w-8 text-center tabular-nums" aria-live="polite">
              {new Intl.NumberFormat(locale).format(display.size)}
            </output>
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={index >= bookTextSizes.length - 1}
              aria-label={m.book_reader_display_larger({}, options)}
              onClick={() => change({ size: bookTextSizes[index + 1]! })}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
        </fieldset>
        {group('width', m.book_reader_display_width({}, options), [
          ['narrow', m.book_reader_display_narrow({}, options)],
          ['standard', m.book_reader_display_standard({}, options)],
          ['wide', m.book_reader_display_wide({}, options)],
        ])}
        {group('face', m.book_reader_display_face({}, options), [
          ['sans', m.book_reader_display_sans({}, options)],
          ['serif', m.book_reader_display_serif({}, options)],
        ])}
        <div className="flex items-end">
          <Button
            type="button"
            variant={display.indent ? 'secondary' : 'outline'}
            className={control}
            aria-pressed={display.indent}
            onClick={() => change({ indent: !display.indent })}
          >
            {m.book_reader_display_indent({}, options)}
          </Button>
        </div>
        {group('spacing', m.book_reader_display_spacing({}, options), [
          ['auto', m.book_reader_display_auto({}, options)],
          ['none', m.book_reader_display_none({}, options)],
        ])}
        {group('punctuation', m.book_reader_display_punctuation({}, options), [
          ['standard', m.book_reader_display_standard({}, options)],
          ['strict', m.book_reader_display_strict({}, options)],
        ])}
        <div className="space-y-2 sm:col-span-2">
          <Button type="button" variant="ghost" className={control} onClick={() => change(defaultBookDisplay)}>
            {m.book_reader_display_reset({}, options)}
          </Button>
          <p role={storageAvailable ? undefined : 'status'} className="text-sm text-muted-foreground">
            {storageAvailable
              ? m.book_reader_display_local({}, options)
              : m.book_reader_display_unavailable({}, options)}
          </p>
        </div>
      </div>
    </details>
  );
}
