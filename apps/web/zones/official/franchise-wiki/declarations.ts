import type { ZonePackage } from '@rezics/zone-sdk';

// What this Zone asks the platform to read at the reader's position. It is plain data in its own file so the platform
// can follow the reader's chosen position and continuity when the package's code is switched off (safe mode, the
// standard look) without importing it; `index.tsx` spreads the same object, so the two cannot differ.
export default {
  positions: { mount: 'franchise' },
  continuity: {},
} as const satisfies Pick<ZonePackage, 'positions' | 'continuity'>;
