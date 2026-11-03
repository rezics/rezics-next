import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { ExportRecord } from './library-export-source.ts';
import type { LibraryExportFinalManifest, LibraryExportManifest } from './library-export-format.ts';

export type LibraryExportDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  workClient: WorkClient | (() => Promise<WorkClient>);
  clock?: KernelClock;
};
export type LibraryExportState = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export type LibraryExportStatus = LibraryExportManifest & {
  state: LibraryExportState;
  fullExport: false;
  first: string | null;
};
export type LibraryExportPage =
  | {
      exportId: string;
      state: 'cancelled' | 'expired' | 'limit' | 'stale';
      records: [];
      next: null;
      manifest: null;
    }
  | {
      exportId: string;
      state: 'collecting' | 'ready';
      records: ExportRecord[];
      next: string | null;
      manifest: LibraryExportFinalManifest | null;
    };
export declare const exportAuthorityTypes: string[];
/** Version 1 cursors and manifests remain readable; new captures use version 2. */
export declare function createLibraryExport(deps: LibraryExportDependencies): {
  create(actor: Actor, requestKey: string, signal?: AbortSignal): Promise<LibraryExportStatus>;
  get(actor: Actor, id: string, signal?: AbortSignal): Promise<LibraryExportStatus>;
  page(actor: Actor, id: string, token: string, signal?: AbortSignal): Promise<LibraryExportPage>;
  cancel(actor: Actor, id: string, signal?: AbortSignal): Promise<LibraryExportStatus>;
};
