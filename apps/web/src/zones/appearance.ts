import { APPEARANCE } from '@rezics/composition';
import type { CompositionDocument } from '@rezics/composition';
import type { ZonePublic } from '../../../../services/kernel/src/zones/contract.ts';

type Tokens = ZonePublic['appearance'];
type TokenName = keyof typeof APPEARANCE;

const dataNames: Record<TokenName, string> = {
  density: 'data-density',
  radius: 'data-radius',
  surface: 'data-surface',
  cover: 'data-cover',
  headingScale: 'data-heading-scale',
};

function tokens(value: unknown): Partial<Tokens> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Partial<Tokens> = {};
  for (const name of Object.keys(APPEARANCE) as TokenName[]) {
    const token = source[name];
    if (typeof token === 'string' && (APPEARANCE[name] as readonly string[]).includes(token)) {
      Object.assign(result, { [name]: token });
    }
  }
  return result;
}

/** Merge the Zone's page defaults with the current document's valid appearance tokens. */
export function zonePageDocument(zone: Tokens, document: CompositionDocument): CompositionDocument {
  const selected = { ...tokens(zone), ...tokens(document.root.props.appearance) };
  return {
    ...document,
    root: {
      ...document.root,
      props: { ...document.root.props, appearance: selected },
    },
  };
}

/** The existing appearance token attributes, kept on the Zone page wrapper. */
export function zoneAppearanceAttributes(zone: Tokens, document: CompositionDocument): Record<string, string> {
  const appearance = {
    ...tokens(zone),
    ...tokens(document.root.props.appearance),
  };
  const attributes: Record<string, string> = {};
  for (const name of Object.keys(APPEARANCE) as TokenName[]) {
    const value = appearance[name];
    if (value !== undefined) attributes[dataNames[name]] = value;
  }
  return attributes;
}
