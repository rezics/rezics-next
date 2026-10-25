import type { CreateMediaResolver } from '../../../specs/imports-media-resolver-driver.ts';
import { createMediaResolver as createProductionResolver } from '../src/media-resolver.ts';

/** Mechanical raw-port naming adapter; all resolver behavior lives in production. */
export const createMediaResolver: CreateMediaResolver = ({ port, ...options }) =>
  createProductionResolver({
    ...options,
    port: {
      readFence: (...args) => port.fence(...args),
      importFromUrl: (...args) => port.request(...args),
      importStatus: (...args) => port.status(...args),
    },
  });
