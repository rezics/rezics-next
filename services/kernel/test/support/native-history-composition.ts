import { installNativeHistoryPreload } from '../../src/composition/preload.ts';

/** Kernel tests load this before any command. It binds the same History WeakMap as server and worker. */
installNativeHistoryPreload();
