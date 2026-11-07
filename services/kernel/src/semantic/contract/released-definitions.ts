/** Exact immutable release acquisition; the producer retains validation and absence semantics. */
export interface ReleasedDefinitions<Source, Release, Active> {
  read(source: Source, digest: string, options?: Readonly<{ composed?: boolean }>): Promise<Release | null>;
  active(source: Source): Promise<Active | null>;
}
