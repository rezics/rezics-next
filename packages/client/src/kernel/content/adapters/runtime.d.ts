import type { ContentAmbient, ContentApplication } from '../contract/index.ts';
/** Construct and bind native Content ports. Composition may override ambient operands.
 * createKernel and startWorker call this so HTTP and workers share one bound application. */
export declare function ensureContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication;
/** Bind native Content for the process lifetime of a kernel or worker. `stop` restores the
 * previous unbound state so tests and shutdown do not leave a borrowed clock in place. */
export declare function startContentApplication(ambient?: Partial<ContentAmbient>): {
    application: ContentApplication;
    stop: () => void;
};
