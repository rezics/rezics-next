/**
 * The copy of a product line page, one field per section pattern in `PATTERNS.md`,
 * in page order. Keys inside `steps`, `tiles` and `rows` name the illustration or
 * feature they belong to, so translations keep them and pages can look them up.
 */
export interface LinePageCopy {
  meta: { title: string; description: string };
  /** The chapter hero: the page's name (from `site.pages`) is set large above this headline. */
  hero: { title: string; lede: string };
  /** The pinned scroll story: each step's text scrolls past while its frame holds the stage. */
  story: { title: string; lede: string; steps: Record<string, { title: string; body: string }> };
  /** The showcase grid: one tile per supporting capability or scene. */
  showcase: { title: string; lede: string; tiles: Record<string, { title: string; body: string }> };
  /** Today's workaround beside the REZICS way, row by row. */
  compare: {
    title: string;
    lede: string;
    today: string;
    rezics: string;
    rows: Record<string, { today: string; rezics: string }>;
  };
  /** The big statement band. */
  statement: { text: string; body: string };
  /** The ledger of feature statements with labels only for post-launch capabilities. */
  ledger: { title: string; lede?: string };
  /** The notify call to action's heading and line for this page. */
  cta: { title: string; body: string };
}
