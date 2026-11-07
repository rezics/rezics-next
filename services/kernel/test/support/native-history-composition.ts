let installation: Promise<void> | undefined;

/**
 * Load SQL-backed composition only after the caller owns a database environment.
 * Configured test processes install eagerly; boot's throwaway callback calls this
 * same entry after provisioning, before importing any native host or support.
 */
export function installNativeTestComposition(): Promise<void> {
  return (installation ??= import('../../src/composition/preload.ts').then(({ installNativeHistoryPreload }) => {
    installNativeHistoryPreload();
  }));
}

if (process.env.DATABASE_URL) await installNativeTestComposition();
