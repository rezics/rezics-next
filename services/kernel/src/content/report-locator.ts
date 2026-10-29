import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
export function createReportLocatorEffect(_pool: Pool): Effect {
  return { name: 'content_report_reporter', types: [], async run() {} };
}
