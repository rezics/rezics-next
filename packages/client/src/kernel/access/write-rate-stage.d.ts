import type { WriteRateContext, WriteRateLimiter } from './write-rate.ts';
import { type MountedRoute } from '../http/request.ts';
export type WriteRateStageOptions = {
    trustedProxyPeers?: readonly string[];
    clientIpHeader?: string;
};
export declare function createWriteRateStage(limiter: WriteRateLimiter, options?: WriteRateStageOptions): (input: {
    request: Request;
    route?: string | undefined;
    routes?: readonly MountedRoute[];
    /** Already resolved by the shared native request stage. */
    mounted?: MountedRoute | undefined;
    body: unknown;
    context: WriteRateContext;
    peer?: string | undefined;
}) => Promise<void>;
