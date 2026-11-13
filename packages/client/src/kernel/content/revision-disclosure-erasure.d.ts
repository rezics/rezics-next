import type { AccessClient } from '../request/access.ts';
import { type RevisionDisclosureErasureContext, type RevisionDisclosureErasureLocator, type RevisionDisclosureErasurePage } from './revision-disclosure-model.ts';
/**
 * Bounded source-home locator for account erasure. One identity, exclusive
 * prefix, no Book history. Callers own the subsequent revoke/delete work.
 */
export declare function pageRevisionDisclosureErasure(client: AccessClient, locator: RevisionDisclosureErasureLocator, context: RevisionDisclosureErasureContext): Promise<RevisionDisclosureErasurePage>;
