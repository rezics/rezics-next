import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { Access } from '../request/access.ts';
import { type WorkClient } from '../work/client.ts';
/** Add once through WorkContext.addEffects before the sole worker is launched.
 * This static list owns no runner, workflow registration or checkpoint. */
export declare function contentEffects(pool: Pool, client: WorkClient): Effect[];
/** Default registration supplies the same fully mounted worker Access as Content work. */
export declare function contentNoticeEffects(pool: Pool, access: Access): Effect[];
