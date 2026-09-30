export interface ZoneWork {
  id: string;
  /** A published prompt or Skill's card, when the Work is one. */
  hub?: { kind: string } | null;
  /** Domain bag the guard must reject. */
  game?: { title: string } | null;
  latestChapter?: { title: string; at: string | null } | null;
}
