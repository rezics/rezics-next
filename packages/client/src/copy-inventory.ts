/** GET /v1/copies filterOptions, matching the mounted personal-routes schema. */
export type CopyInventory = {
  kinds: CopyInventoryFacet;
  statuses: CopyInventoryFacet;
};
type CopyInventoryFacet = {
  state: 'available' | 'unavailable';
  choices: {
    id: string;
    label: string;
    labelLanguage?: string;
    meaning: 'available' | 'unsupported' | 'unavailable';
  }[];
};
