import * as v from 'valibot';
import { deLocalizeUrl } from '../paraglide/runtime.js';
import { realmAppearanceChoiceSchema, type RealmAppearanceChoice, type RealmImageSlot } from './realm-presentation';

export type RealmAppearanceReference = { href: string; choice: RealmAppearanceChoice };

/** Navigation syntax only. The existing native selection owns admission and disclosure. */
export function realmAppearanceReference(
  text: string,
  origin: string,
  realmId: string,
  slot: RealmImageSlot | 'rules',
): RealmAppearanceReference | null {
  const link = text.trim();
  // Accept root-relative links or explicit HTTP(S) URLs, without URL-parser path repair.
  const path = /^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)$/i.exec(link)?.[1];
  if (!path || link.length > 2048 || /[\s\\%]/u.test(link) || link.startsWith('//') || /^https?:\/\/[^/]*@/i.test(link))
    return null;
  try {
    const url = new URL(link, origin);
    if (
      url.origin !== new URL(origin).origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== path
    )
      return null;
    const image = /^\/media\/([^/]+)\/(?:avif|webp)-[1-9][0-9]*$/.exec(path);
    const rules = /^\/posts\/([^/]+)\/revisions\/([^/]+)$/.exec(deLocalizeUrl(url).pathname);
    const choice =
      slot === 'rules'
        ? rules && { kind: 'rules', realmId, postId: rules[1], revisionId: rules[2] }
        : image && {
            kind: 'image',
            realmId,
            mediaId: image[1],
            purpose: slot === 'avatar' ? 'realm-icon' : 'realm-banner',
          };
    const parsed = v.safeParse(realmAppearanceChoiceSchema, choice);
    return parsed.success ? { href: url.pathname, choice: parsed.output } : null;
  } catch {
    return null;
  }
}
