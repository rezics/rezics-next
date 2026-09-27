import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { hash } from '../work/activate.ts';

const nativeId = Type.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const origin = Type.String({ pattern: '^https://[^\\s/?#]{1,500}$', maxLength: 512 });
const slot = Type.Union([Type.Literal('hero'), Type.Literal('header'),
  Type.Literal('workCard'), Type.Literal('background'), Type.Literal('footer'),
  Type.String({ pattern: '^module:[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 72 })]);

export const FirstPartyBundle = Type.Object({
  profile: Type.Literal('first-party-bundle-v1'),
  hostZone: nativeId,
  entry: Type.String({ pattern: '^assets/[A-Za-z0-9][A-Za-z0-9._/-]*\\.js$', maxLength: 160 }),
  files: Type.Array(Type.Object({
    path: Type.String({ pattern: '^assets/[A-Za-z0-9][A-Za-z0-9._/-]*\\.(?:js|css|woff2)$',
      maxLength: 160 }),
    digest,
    gzipBytes: Type.Integer({ minimum: 1, maximum: 300_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  slots: Type.Array(slot, { minItems: 1, maxItems: 32 }),
  connectOrigins: Type.Array(origin, { maxItems: 16 }),
  imageOrigins: Type.Array(origin, { maxItems: 16 }),
  fontOrigins: Type.Array(origin, { maxItems: 4 }),
}, { additionalProperties: false });

export type FirstPartyBundle = Static<typeof FirstPartyBundle>;
export class InvalidFirstPartyBundle extends Error {}

/** Canonical digest covers every emitted file and execution permission. */
export function checkFirstPartyBundle(value: unknown): { bundle: FirstPartyBundle;
  dependencyDigest: string; cssBytes: number; jsBytes: number; fontBytes: number } {
  if (!Value.Check(FirstPartyBundle, value)) throw new InvalidFirstPartyBundle('bundle format differs');
  const files = [...value.files].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(file => file.path)).size !== files.length
    || !files.some(file => file.path === value.entry)
    || files.some(file => file.path.includes('..') || file.path.includes('//'))) {
    throw new InvalidFirstPartyBundle('bundle paths are ambiguous or the entry is missing');
  }
  const cssBytes = files.filter(file => file.path.endsWith('.css'))
    .reduce((sum, file) => sum + file.gzipBytes, 0);
  const jsBytes = files.filter(file => file.path.endsWith('.js'))
    .reduce((sum, file) => sum + file.gzipBytes, 0);
  const fontBytes = files.filter(file => file.path.endsWith('.woff2'))
    .reduce((sum, file) => sum + file.gzipBytes, 0);
  if (cssBytes > 40_000 || jsBytes > 50_000 || fontBytes > 300_000
    || new Set(value.slots).size !== value.slots.length) {
    throw new InvalidFirstPartyBundle('bundle byte or slot budget exceeded');
  }
  const normalize = (items: string[]) => {
    if (new Set(items).size !== items.length) throw new InvalidFirstPartyBundle('duplicate bundle origin');
    for (const item of items) {
      const parsed = new URL(item);
      if (parsed.origin !== item || parsed.protocol !== 'https:') {
        throw new InvalidFirstPartyBundle('bundle origin is not exact HTTPS');
      }
    }
    return [...items].sort();
  };
  const canonical = { ...value, files, slots: [...value.slots].sort(),
    connectOrigins: normalize(value.connectOrigins), imageOrigins: normalize(value.imageOrigins),
    fontOrigins: normalize(value.fontOrigins) };
  return { bundle: canonical, dependencyDigest: hash(JSON.stringify(canonical)),
    cssBytes, jsBytes, fontBytes };
}
