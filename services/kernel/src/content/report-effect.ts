import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { unfinishedPort } from './model.ts';

export function createReportEffect(_pool: Pool): Effect {
  throw unfinishedPort('createReportEffect');
}

export async function applyReportEffect(_pool: Pool, _event: CloudEvent): Promise<void> {
  throw unfinishedPort('applyReportEffect');
}
