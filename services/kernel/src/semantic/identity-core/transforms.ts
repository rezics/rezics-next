/** The store page and executable mapping consume the same immutable constant transform. */
export function identityEpochChangeTerminal(
  intent: IdentityEpochLibraryTransform,
  remainder: string | null,
  original: string,
  previous: string,
): string {
  if (intent.kind === 'merge') return intent.survivor;
  if (original === intent.original) return intent.kind === 'unmerge' ? intent.original : intent.terminal;
  return previous === intent.original && remainder !== null ? remainder : previous;
}

/** Only the constant fields consumed by pageChanges; unrelated immutable intent data stays native. */
export type IdentityEpochLibraryTransform =
  | Readonly<{ kind: 'merge'; survivor: string }>
  | Readonly<{ kind: 'unmerge'; original: string }>
  | Readonly<{ kind: 'repoint'; original: string; terminal: string }>;

export type IdentityTransformSource = Readonly<{
  input_original: string;
  terminal: string;
  observed_count: string;
  remainder_terminal?: string | null;
}>;
export type IdentityRemainder =
  | Readonly<{ state: 'ready'; terminal: string | null }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'overflow' }>
  | Readonly<{ state: 'stale' }>;

/** Captured immutable input values; native adapters retain error construction and admission. */
export function classifyIdentityRemainder(
  intent: IdentityEpochLibraryTransform,
  sources: readonly IdentityTransformSource[],
): IdentityRemainder {
  if (intent.kind === 'merge') return { state: 'ready', terminal: null };
  const source = sources.find((row) => row.input_original === intent.original);
  if (!source) return { state: 'unavailable' };
  const count = BigInt(source.observed_count);
  if (count < 1n) return { state: 'unavailable' };
  if (count - 1n > 4096n) return { state: 'overflow' };
  if (intent.kind === 'repoint') {
    const target = sources.find((row) => row.input_original === intent.terminal);
    if (!target || target.terminal !== intent.terminal || source.terminal === target.terminal)
      return { state: 'stale' };
  }
  if (source.terminal !== intent.original) return { state: 'ready', terminal: null };
  const remainder = source.remainder_terminal ?? null;
  if (count > 1n !== (remainder !== null) || remainder === intent.original) return { state: 'unavailable' };
  return { state: 'ready', terminal: remainder };
}
