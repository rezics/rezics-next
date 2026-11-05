export const PERSONAL_DIRECTORY_CURSOR_LIMITS = {
  collections: 4096,
  following: 2048,
} as const;

export type PersonalDirectoryAddress = {
  cursor: string | null;
  valid: boolean;
};

/** Keep malformed values distinguishable from the first page while treating cursors as opaque. */
export function personalDirectoryAddress(value: unknown, maximumLength: number): PersonalDirectoryAddress {
  if (value === undefined) return { cursor: null, valid: true };
  if (typeof value === 'string' && value.length > 0 && value.length <= maximumLength)
    return { cursor: value, valid: true };
  return { cursor: null, valid: false };
}
