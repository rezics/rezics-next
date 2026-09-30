import { SeedApiError } from './api.ts';

/** Refresh every input from Main and use a new key after its explicit cancelled-basis outcome. */
export async function refreshMetadataBasis<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof SeedApiError) || error.status !== 409) throw error;
      let code: unknown;
      try { code = (JSON.parse(error.detail) as { code?: unknown }).code; } catch { throw error; }
      if (code !== 'metadata_basis_changed') throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
