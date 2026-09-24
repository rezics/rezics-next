/** Exact candidate payloads and expected outcomes from the retired helper suite. */
export interface NativeProfileFixture {
  readonly id: string;
  readonly sha256: string;
  readonly cases: Record<string, {
    readonly turtle: string;
    readonly args: Record<string, string>;
    readonly expected: boolean;
    readonly pathHint: string | null;
    readonly focus: readonly { readonly shape: string; readonly focus: string }[];
  }>;
}
