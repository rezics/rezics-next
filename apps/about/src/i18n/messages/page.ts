/** The copy every product page shares. English defines it; other locales complete it. */
export interface PageCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string };
  /** The section that pairs a product illustration with a paragraph. */
  scene: { title: string; body: string };
  featuresTitle: string;
}
