import type { AccessClient } from '../request/access.ts';
import { type RevisionDisclosureSource, type RevisionDisclosureTarget } from './revision-disclosure-model.ts';
/** Exact private opening observation. Attachment readability is not this check. */
export declare function observeRevisionDisclosureSource(client: AccessClient, target: RevisionDisclosureTarget): Promise<RevisionDisclosureSource | null>;
export declare function revisionDisclosureSourceCurrent(client: AccessClient, source: RevisionDisclosureSource): Promise<boolean>;
