import { Type } from 'typebox';
import { PACKAGE_ID_PATTERN, RELEASE_ID_PATTERN } from './contract.ts';

export function launcherEvents() {
  const release = Type.Object(
    {
      packageId: Type.String({ pattern: PACKAGE_ID_PATTERN }),
      releaseId: Type.String({ pattern: RELEASE_ID_PATTERN }),
    },
    { additionalProperties: false },
  );

  return {
    'com.rezics.launcher.release.published.v1': release,
    'com.rezics.launcher.release.withdrawn.v1': release,
  } as const;
}
