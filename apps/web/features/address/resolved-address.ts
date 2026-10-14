import type { ResolvedAddress } from './client.ts';
import { parseAddressSegment } from './path.ts';

const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The address grammar check without the server address client's network imports, so a browser story can run the frame reader. */
export function resolvedAddress(value: unknown): ResolvedAddress | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as ResolvedAddress;
  const address = data.canonical;
  const chapterPlace = address && /^\/w\/[^/]+\/read\/$/.test(address.prefix);
  if (
    data.profile !== 'address-resolution-v1' ||
    data.status !== 'resolved' ||
    typeof data.scope !== 'string' ||
    !/^(?:agent|space|work|resource|concept|zone:https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
      data.scope,
    ) ||
    typeof data.key !== 'string' ||
    !['current', 'redirect'].includes(data.state) ||
    !nativeIri.test(data.holder) ||
    !address ||
    typeof address.key !== 'string' ||
    // Resource UUIDs are legacy lookups. Reader occurrences retain their
    // owning route's UUID grammar, independently of the Book's address key.
    !parseAddressSegment(address.key) ||
    (parseAddressSegment(address.key)?.kind === 'uuid' && !chapterPlace) ||
    typeof address.suffixSource !== 'string' ||
    !/^\/(?:@|(?:a|r|z|w|e|concepts)\/|z\/[^/]+\/[^/]+\/|w\/[^/]+\/(?:read\/)?)$/.test(
      address.prefix,
    ) ||
    (data.capabilities &&
      Object.values(data.capabilities).some(
        (value) => typeof value !== 'string' || !nativeIri.test(value),
      ))
  )
    return null;
  return data;
}
