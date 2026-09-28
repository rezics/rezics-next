import type { ZoneTokens } from '@rezics/zone-sdk';
import { contrast, inkOn, mix, parseHex, readableOn, type Rgb, toHex } from './color.ts';

/**
 * Rezics Aura's surfaces (packages/ui/src/styles.css; a test keeps them in
 * step). Zone colors are derived against these literal values because a
 * custom property cannot be redefined from its own inherited value.
 */
export const auraSurfaces = {
  light: { background: '#f9f6f2', card: '#fefcf9', foreground: '#2b343d', primaryForeground: '#ffffff' },
  dark: { background: '#0d1218', card: '#151b21', foreground: '#e7e4df', primaryForeground: '#0b1626' },
} as const;

type Scheme = keyof typeof auraSurfaces;

/** The reader's display mode, from the shell's theme cookie. */
export type ReaderTheme = 'system' | 'light' | 'dark';

export interface ZoneTheme {
  /** Class names for the Zone's scope element. */
  className: string;
  /** Custom properties, set inline so the first server paint is themed. */
  style: Record<`--${string}`, string>;
}

// Module panels, then the UI kit's base radius (buttons, chips, tabs).
const radii = { sm: ['0.375rem', '0.5rem'], md: ['0.875rem', '1rem'], lg: ['1.375rem', '1.25rem'] } as const;
const fonts = {
  sans: 'var(--font-interface)',
  serif: 'var(--font-work-serif)',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", var(--font-interface)',
} as const;
const tints = { none: 0, subtle: 0.035, accent: 0.075 } as const;

const pair = (light: string, dark: string) => light === dark ? light : `light-dark(${light}, ${dark})`;

/** The Zone page's own surface: panels sit on a slightly deeper page, tinted by the accent. */
function pageSurface(tokens: ZoneTokens, scheme: Scheme, accent: Rgb): Rgb {
  const surface = auraSurfaces[scheme];
  const base = parseHex(surface.background);
  const page = tokens.pageSurface === 'cards' && scheme === 'light'
    ? mix(parseHex(surface.foreground), 0.045, base) : base;
  return tints[tokens.surfaceTint] ? mix(accent, tints[tokens.surfaceTint], page) : page;
}

/** Accent roles for one scheme: every text-bearing tone passes WCAG AA on the surfaces it sits on. */
export function accentRoles(tokens: ZoneTokens, scheme: Scheme) {
  const surface = auraSurfaces[scheme];
  const raw = parseHex(tokens.accent);
  const page = pageSurface(tokens, scheme, raw);
  const card = parseHex(surface.card);
  const surfaces = [page, card, parseHex(surface.background)];
  // 4.6, not 4.5: the hex the browser receives is rounded to 8 bits per channel.
  const primary = readableOn(raw, surfaces, 4.6);
  const primaryForeground = inkOn(primary, parseHex(auraSurfaces.dark.primaryForeground));
  // A pale wash of the accent behind selected tabs and chips, with its own readable ink.
  const accent = mix(raw, scheme === 'light' ? 0.12 : 0.2, card);
  const accentForeground = readableOn(raw, [accent], 4.6);
  return { primary, primaryForeground, accent, accentForeground, page, card };
}

/** How the Zone's `colorScheme` combines with the reader's display mode. */
export function zoneScheme(tokens: ZoneTokens, reader: ReaderTheme): 'dark' | null {
  return reader === 'system' && tokens.colorScheme === 'dark' ? 'dark' : null;
}

/**
 * Maps presentation tokens to CSS custom properties on the Zone's scope.
 * Zones use REZICS's shared visual language (docs/plan/frontend.md, "Zones"):
 * they differ in how they lay information out, not in colour or type. So only
 * structure applies (density, and modules as panels or on the page); a Zone's
 * accent, tint, scheme, radius and fonts apply only when it asks for its own
 * look (`ownLook`), which no Zone can do yet. With `enabled` false (the reader
 * chose the standard look) modules also sit on the page itself.
 */
export function zoneTheme(tokens: ZoneTokens, { reader, enabled, ownLook = false }:
  { reader: ReaderTheme; enabled: boolean; ownLook?: boolean }): ZoneTheme {
  // Covers keep the catalogue's proportions for each kind of Work, so coverStyle has no effect here;
  // density sets how many covers a shelf shows across.
  const structure = tokens.density === 'compact'
    ? { '--zone-gap': '1rem', '--zone-pad': '1rem', '--zone-shelf-gap': '1rem', '--zone-tiles': '6' }
    : { '--zone-gap': '1.75rem', '--zone-pad': '1.25rem', '--zone-shelf-gap': '1.5rem', '--zone-tiles': '5' };
  const panels = enabled && tokens.pageSurface === 'cards';
  const shared = { ...structure, '--zone-page': 'var(--background)',
    '--zone-panel': panels ? 'var(--card)' : 'transparent', '--zone-panel-pad': panels ? 'var(--zone-pad)' : '0px',
    '--zone-radius-card': radii.md[0], '--zone-heading-font': fonts.sans, '--zone-heading-scale': '1' };
  if (!enabled || !ownLook) return { className: 'zone-scope', style: shared };
  const light = accentRoles(tokens, 'light');
  const dark = accentRoles(tokens, 'dark');
  const both = (role: keyof typeof light) => pair(toHex(light[role]), toHex(dark[role]));
  const [card, kit] = radii[tokens.cardRadius];
  return {
    className: ['zone-scope', zoneScheme(tokens, reader) ?? ''].join(' ').trim(),
    style: {
      ...structure,
      '--primary': both('primary'), '--primary-foreground': both('primaryForeground'),
      '--ring': both('primary'), '--accent': both('accent'), '--accent-foreground': both('accentForeground'),
      '--zone-accent': both('primary'), '--zone-page': both('page'),
      '--zone-panel': tokens.pageSurface === 'cards' ? 'var(--card)' : 'transparent',
      '--zone-panel-pad': tokens.pageSurface === 'cards' ? 'var(--zone-pad)' : '0px',
      '--zone-radius-card': card, '--radius': kit,
      '--zone-heading-font': fonts[tokens.fontPairing],
      '--zone-heading-scale': tokens.headingFontScale === 'lg' ? '1.2' : '1',
    },
  };
}

/** The weakest contrast of the Zone's text-bearing accent on its surfaces, per scheme (for tests and review). */
export function weakestContrast(tokens: ZoneTokens): Record<Scheme, number> {
  const measure = (scheme: Scheme) => {
    const roles = accentRoles(tokens, scheme);
    return Math.min(contrast(roles.primary, roles.page), contrast(roles.primary, roles.card),
      contrast(roles.primaryForeground, roles.primary), contrast(roles.accentForeground, roles.accent));
  };
  return { light: measure('light'), dark: measure('dark') };
}
