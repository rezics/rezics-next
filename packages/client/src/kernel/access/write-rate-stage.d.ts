import type { WriteRateContext, WriteRateLimiter } from './write-rate.ts';
type MountedRoute = {
    method: string;
    path: string;
    hooks?: {
        detail?: unknown;
    };
};
export type WriteRateStageOptions = {
    trustedProxyPeers?: readonly string[];
    clientIpHeader?: string;
};
export declare function createWriteRateStage(limiter: WriteRateLimiter, options?: WriteRateStageOptions): (input: {
    request: Request;
    route?: string | undefined;
    routes: readonly MountedRoute[];
    body: unknown;
    context: WriteRateContext;
    peer?: string | undefined;
}) => Promise<void>;
export {};
