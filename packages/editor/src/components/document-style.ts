/** Authored values remain stored even when this renderer cannot display their CSS syntax. */
export const documentAlignments = ['left', 'center', 'right', 'justify'] as const;
export type DocumentAlignment = (typeof documentAlignments)[number];
export const documentEmphasisShapes = ['dot', 'sesame', 'circle', 'double-circle', 'triangle'] as const;
const colorFunctions = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'var',
  'calc',
  'min',
  'max',
  'clamp',
]);
export const wireColor = (value: unknown): value is string =>
  typeof value === 'string' && !/[;{}\u0000-\u001f]/.test(value);
export function safeColor(value: unknown): string | undefined {
  if (!wireColor(value) || value.length > 512 || !/^[a-zA-Z0-9#.,%()+\-/* _]+$/.test(value)) return undefined;
  if (value.includes('/*') || value.includes('*/')) return undefined;
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  for (const match of value.matchAll(/([a-zA-Z-]+)\s*\(/g))
    if (!colorFunctions.has(match[1]!.toLowerCase())) return undefined;
  return value.trim() || undefined;
}
export function safeAlignment(value: unknown): DocumentAlignment | undefined {
  return documentAlignments.includes(value as DocumentAlignment) ? (value as DocumentAlignment) : undefined;
}
export function safeHeadingLevel(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : 1;
}

export function validTextStyle(value: unknown): value is Record<string, string | null> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) => ['color', 'backgroundColor'].includes(key) && (entry === null || wireColor(entry)),
    )
  );
}
export function validTextEmphasis(value: unknown): value is Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    key === 'color'
      ? entry === null || wireColor(entry)
      : key === 'shape'
        ? documentEmphasisShapes.includes(entry as (typeof documentEmphasisShapes)[number])
        : key === 'fill'
          ? ['filled', 'open'].includes(entry as string)
          : key === 'position'
            ? ['over', 'under'].includes(entry as string)
            : false,
  );
}
export function parseFormattingData(element: HTMLElement, name: 'text-style' | 'text-emphasis') {
  const raw = element.getAttribute(`data-document-${name}`);
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return (name === 'text-style' ? validTextStyle(value) : validTextEmphasis(value)) ? value : false;
  } catch {
    return false;
  }
}
export function parseCodeLanguage(element: HTMLElement): string | null | undefined | false {
  const raw = element.getAttribute('data-document-code-language');
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' || value === null ? value : false;
  } catch {
    return false;
  }
}
export function validFormattingMetadata(root: ParentNode): boolean {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[data-document-text-style],[data-document-text-emphasis],[data-document-code-language]',
    ),
  ].every(
    (element) =>
      (!element.hasAttribute('data-document-text-style') || parseFormattingData(element, 'text-style') !== false) &&
      (!element.hasAttribute('data-document-text-emphasis') ||
        parseFormattingData(element, 'text-emphasis') !== false) &&
      (!element.hasAttribute('data-document-code-language') || parseCodeLanguage(element) !== false),
  );
}
export function textStyleCSS(attrs: Record<string, unknown>): string {
  const color = safeColor(attrs.color),
    background = safeColor(attrs.backgroundColor);
  return [color && `color:${color}`, background && `background-color:${background}`].filter(Boolean).join(';');
}
export function textEmphasisCSS(attrs: Record<string, unknown>): string {
  const shape = documentEmphasisShapes.includes(attrs.shape as (typeof documentEmphasisShapes)[number])
    ? attrs.shape
    : 'dot';
  const fill = attrs.fill === 'open' ? 'open' : 'filled';
  const position = attrs.position === 'under' ? 'under' : 'over';
  const color = safeColor(attrs.color);
  return `text-emphasis-style:${fill} ${shape};text-emphasis-position:${position}${color ? `;text-emphasis-color:${color}` : ''}`;
}

/** CSSOM parses each declaration, then only admitted properties and values are copied to a fresh declaration. */
export function sanitizeFormattingStyle(element: HTMLElement): void {
  const input = element.style;
  const output = element.ownerDocument.createElement('span').style;
  const copy = (property: string, value: string | undefined) => {
    if (value) output.setProperty(property, value);
  };
  copy('color', safeColor(input.getPropertyValue('color')));
  copy('background-color', safeColor(input.getPropertyValue('background-color')));
  copy('text-align', safeAlignment(input.getPropertyValue('text-align')));
  const emphasisStyle = input.getPropertyValue('text-emphasis-style').trim();
  if (/^(?:(?:filled|open) )?(?:dot|sesame|circle|double-circle|triangle)$/.test(emphasisStyle))
    copy('text-emphasis-style', emphasisStyle);
  const position = input.getPropertyValue('text-emphasis-position').trim();
  if (['over', 'under', 'over right', 'under right', 'over left', 'under left'].includes(position))
    copy('text-emphasis-position', position);
  copy('text-emphasis-color', safeColor(input.getPropertyValue('text-emphasis-color')));
  const weight = input.getPropertyValue('font-weight');
  if (['bold', 'bolder', '600', '700', '800', '900'].includes(weight)) copy('font-weight', weight);
  if (input.getPropertyValue('font-style') === 'italic') copy('font-style', 'italic');
  const decoration = (input.getPropertyValue('text-decoration-line') || input.getPropertyValue('text-decoration'))
    .split(/\s+/)
    .filter((value) => ['underline', 'line-through'].includes(value));
  if (decoration.length) copy('text-decoration-line', [...new Set(decoration)].join(' '));
  const ruby = input.getPropertyValue('ruby-position');
  if (['over', 'under', 'inter-character'].includes(ruby)) copy('ruby-position', ruby);
  if (output.cssText) element.setAttribute('style', output.cssText);
  else element.removeAttribute('style');
}
