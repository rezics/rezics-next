/** Library owns page bindings and continuation keys; composition selects the opaque token implementation. */
export type LibraryCursorBinding = Readonly<{
  operation: string;
  parameters: Readonly<Record<string, string | number | null>>;
}>;

export interface LibraryCursorCapability<Keys> {
  decode(
    keys: Keys,
    binding: LibraryCursorBinding,
    cursor: string,
  ): { ok: false } | { ok: true; epoch: number; after: readonly unknown[] };
  encode(keys: Keys, binding: LibraryCursorBinding, cursor: { epoch: number; after: readonly string[] }): string;
}
