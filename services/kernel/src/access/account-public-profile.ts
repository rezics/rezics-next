import type { AccountPublicViews } from './account-data.ts';

/** Creation defaults belong to the writer. Readers admit only stored explicit publication choices. */
export function accountPublicViews(value: unknown): AccountPublicViews {
  const flags = value as Partial<Record<keyof AccountPublicViews, unknown>> | null;
  return {
    posts: flags?.posts === true,
    reviews: flags?.reviews === true,
    collections: flags?.collections === true,
    realms: flags?.realms === true,
  };
}
