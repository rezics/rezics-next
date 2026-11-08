import type { ContentApplication } from '../contract/index.ts';
export declare function bindContentApplication(application: ContentApplication): ContentApplication;
export declare function contentApplication(): ContentApplication;
export declare function tryContentApplication(): ContentApplication | undefined;
/** Tests restore the process binding; createKernel rebinds native ports. */
export declare function unbindContentApplication(): void;
/** Request IDs come from the composed identity factory, never from a hidden UUID source. */
export declare function contentRequestId(): string;
/** Wall-clock budgets come from the composed `now`, never from a hidden Date.now. */
export declare function contentNow(): number;
/** Domain ranking and command time come from the composed clock. */
export declare function contentClock(): Date;
