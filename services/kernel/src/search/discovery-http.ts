/** Stable compatibility exports; response families live under http/discovery. */
export {
  DiscoveryPageSchema,
  admitDiscoveryHit,
  admitDiscoveryPage,
  discoveryHttpPage,
} from './http/discovery/page.ts';
export type { DiscoveryHttpPage } from './http/discovery/page.ts';
