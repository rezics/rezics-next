// The cookie supplies the first paint. Main owns the account copy for signed-in readers.

export const READER_COOKIE = 'rezics_reader';

/** Body text sizes in px, smallest first. */
export const textSizes = [15, 17, 19, 22, 25] as const;
/** Measures in rem; CJK text runs at about one glyph per rem at the default size. */
export const lineWidths = { narrow: 32, medium: 40, wide: 50 } as const;
export const typefaces = ['serif', 'sans'] as const;

export type LineWidth = keyof typeof lineWidths;
export type Typeface = (typeof typefaces)[number];
export interface ReaderSettings { size: number; width: LineWidth; face: Typeface;
  indent?: boolean; theme?: 'system' | 'light' | 'dark'; cjkSpacing?: 'auto' | 'none';
  cjkPunctuation?: 'standard' | 'strict' }

export type CompleteReaderSettings = Required<ReaderSettings>;
export const completeReaderSettings = (settings: ReaderSettings): CompleteReaderSettings => ({
  size: settings.size, width: settings.width, face: settings.face,
  indent: settings.indent ?? false, theme: settings.theme ?? 'system',
  cjkSpacing: settings.cjkSpacing ?? 'auto', cjkPunctuation: settings.cjkPunctuation ?? 'standard',
});

export const defaultReaderSettings: ReaderSettings = { size: 1, width: 'medium', face: 'serif' };

/** Settings from the cookie; anything missing or unknown keeps its default. */
export function parseReaderSettings(value: string | undefined): ReaderSettings {
  const params = new URLSearchParams(value ?? '');
  const size = Number(params.get('size'));
  const width = params.get('width');
  const face = params.get('face');
  const indent = params.get('indent');
  const theme = params.get('theme');
  const cjkSpacing = params.get('cjkSpacing');
  const cjkPunctuation = params.get('cjkPunctuation');
  return {
    size: Number.isInteger(size) && size >= 0 && size < textSizes.length && params.has('size')
      ? size : defaultReaderSettings.size,
    width: width && width in lineWidths ? width as LineWidth : defaultReaderSettings.width,
    face: typefaces.includes(face as Typeface) ? face as Typeface : defaultReaderSettings.face,
    ...(indent === 'true' || indent === 'false' ? { indent: indent === 'true' } : {}),
    ...(theme === 'system' || theme === 'light' || theme === 'dark' ? { theme } : {}),
    ...(cjkSpacing === 'auto' || cjkSpacing === 'none' ? { cjkSpacing } : {}),
    ...(cjkPunctuation === 'standard' || cjkPunctuation === 'strict' ? { cjkPunctuation } : {}),
  };
}

export function serializeReaderSettings(settings: ReaderSettings): string {
  return new URLSearchParams({ size: String(settings.size), width: settings.width, face: settings.face,
    ...(settings.indent !== undefined ? { indent: String(settings.indent) } : {}),
    ...(settings.theme ? { theme: settings.theme } : {}),
    ...(settings.cjkSpacing ? { cjkSpacing: settings.cjkSpacing } : {}),
    ...(settings.cjkPunctuation ? { cjkPunctuation: settings.cjkPunctuation } : {}),
  }).toString();
}

/** A reading position Main stores for a chapter: the paragraph the reader reached. */
export const paragraphPosition = (index: number) => `p:${index}`;

export function parsePosition(position: string | null | undefined): number | null {
  const match = position?.match(/^p:(\d{1,6})$/);
  return match ? Number(match[1]) : null;
}
