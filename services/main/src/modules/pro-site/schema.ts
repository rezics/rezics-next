import type { OwnerColumns } from '../commerce/owner-columns.ts';

/** Access database `site` schema from migration 092: fixed-Realm site
 * configuration, including the operated Rezics Pro site. */
export const siteSchema = 'site';

export const siteColumns = {
  definition: { id: 'uuid', host: 'text', head_revision: 'int8', created_at: 'timestamptz' },
  definition_revision: { site_id: 'uuid', revision: 'int8', kind: 'text', realm: 'text',
    lifecycle: 'text', presentation_profile: 'text', required_benefit: 'text?',
    created_at: 'timestamptz' },
} as const satisfies OwnerColumns;
