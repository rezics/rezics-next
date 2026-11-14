/** Addresses only: the controller retains one native metadata page and no previous bodies or pages. */
export type VersionMovement = 'first' | 'previous' | 'next';
export type VersionAddress = Readonly<{ cursor: string | null; movement: VersionMovement }>;
export type VersionNavigation = Readonly<{
  admitted: boolean;
  cursor: string | null;
  predecessors: readonly (string | null)[];
  /** Retained on failure, including a failed first page whose cursor is null. */
  staged: VersionAddress | null;
}>;

export function initialVersionNavigation(): VersionNavigation {
  return { admitted: false, cursor: null, predecessors: [], staged: null };
}

export function versionAddress(
  navigation: VersionNavigation,
  movement: VersionMovement | 'retry',
  nextCursor: string | null,
): VersionAddress | null {
  switch (movement) {
    case 'retry':
      return navigation.staged;
    case 'first':
      return { cursor: null, movement };
    case 'previous':
      return navigation.predecessors.length
        ? { cursor: navigation.predecessors[navigation.predecessors.length - 1]!, movement }
        : null;
    case 'next':
      return navigation.admitted && nextCursor !== null ? { cursor: nextCursor, movement } : null;
  }
}

/** Called only after the response for the staged address succeeds. Failed movement changes no history. */
export function admitVersionAddress(navigation: VersionNavigation, address: VersionAddress): VersionNavigation {
  const predecessors =
    address.movement === 'first'
      ? []
      : address.movement === 'previous'
        ? navigation.predecessors.slice(0, -1)
        : [...navigation.predecessors, navigation.cursor].slice(-8);
  return { admitted: true, cursor: address.cursor, predecessors, staged: null };
}
