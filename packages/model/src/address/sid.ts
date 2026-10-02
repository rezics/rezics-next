/** Bitcoin Base58 order is part of the address protocol. Never reorder it. */
export const SID_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const SID_LENGTH = 22;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UUID = 1n << 128n;

/** All UUID bits, including version and variant, are retained. */
export function uuidToSid(uuid: string): string {
  if (!UUID.test(uuid)) throw new Error('Invalid UUID');
  let value = BigInt(`0x${uuid.replaceAll('-', '')}`);
  let result = '';
  do {
    result = SID_ALPHABET[Number(value % 58n)]! + result;
    value /= 58n;
  } while (value);
  return result.padStart(SID_LENGTH, SID_ALPHABET[0]!);
}

/** No trimmed, overflowing, short or alternate spelling is accepted. */
export function sidToUuid(sid: string): string {
  if (sid.length !== SID_LENGTH) throw new Error('Invalid sid');
  let value = 0n;
  for (const character of sid) {
    const digit = SID_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Invalid sid');
    value = value * 58n + BigInt(digit);
  }
  if (value >= MAX_UUID) throw new Error('Invalid sid');
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isSid(value: string): boolean {
  try {
    sidToUuid(value);
    return true;
  } catch {
    return false;
  }
}

/** Slugs decorate an identity; the resolver never uses their text. */
export function identityKeyUuid(key: string): string | null {
  if (UUID.test(key)) return key.toLowerCase();
  const sid = key.slice(0, SID_LENGTH);
  if (key.length !== SID_LENGTH && key[SID_LENGTH] !== '-') return null;
  try {
    return sidToUuid(sid);
  } catch {
    return null;
  }
}
