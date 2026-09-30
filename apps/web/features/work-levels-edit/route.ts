// Addresses of the Work-level edit pages, `/w/{ref}/edit/parts`, `/edit/relations` and
// `/edit/editions`, and how a person names another Work to them.

export const editSections = ['parts', 'relations', 'editions'] as const;
export type EditSection = (typeof editSections)[number];

export const editHref = (ref: string, section: EditSection) => `/w/${encodeURIComponent(ref)}/edit/${section}`;

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The Work a person named by pasting its address, its `https://rezics.com/id/…` IRI or its bare ID;
 * null when the text holds no ID. A slug names nothing here: only an ID is a Work's identity.
 */
export function workIdFrom(text: string): string | null {
  const found = text.trim().match(uuid);
  return found ? found[0].toLowerCase() : null;
}

export const workIri = (id: string) => `https://rezics.com/id/${id}`;
