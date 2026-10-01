import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';

// `GET /v1/me/library-export` (`services/main/src/routes/library-export.ts`): the whole library as
// `rezics-library-export-v1` rows in resumable pages. Shapes come from the typed Eden client.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type ExportPage = Ok<MainClient['v1']['me']['library-export']['get']>;
export type ExportRow = ExportPage['rows'][number];

/** `moved`: the library changed or the cursor expired (Main keeps one for 30 minutes), so the download starts again. */
export type ExportFailure = 'moved' | 'denied' | 'unavailable';
export class ExportError extends Error {
  constructor(readonly failure: ExportFailure, message: string = failure) { super(message); }
}

export interface ExportApi {
  page: (position: { cursor?: string; snapshot?: string }) => Promise<ExportPage>;
}

export function mainExportApi(agent: string, main: () => MainClient = browserMainApi): ExportApi {
  return {
    async page({ cursor, snapshot }) {
      const answer = await main().v1.me['library-export'].get({ query: { actingSubject: agent,
        ...cursor ? { cursor } : {}, ...snapshot ? { snapshot } : {} } });
      if (answer.data) return answer.data;
      const status = answer.status;
      throw new ExportError(status === 409 ? 'moved' : status === 401 || status === 403 ? 'denied' : 'unavailable');
    },
  };
}
