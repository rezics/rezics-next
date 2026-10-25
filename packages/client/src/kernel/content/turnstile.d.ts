export type TurnstileVerification = {
    ok: true;
    hostname: string;
    action: string;
    challengeTimestamp?: string;
} | {
    ok: false;
    reason: 'invalid' | 'unavailable';
};
export type TurnstileVerifyOptions = {
    signal?: AbortSignal;
    deadline?: number;
};
export type TurnstileVerifier = {
    verify(token: string, options?: TurnstileVerifyOptions): Promise<TurnstileVerification>;
};
export type TurnstileVerifierConfig = {
    secret: string | undefined;
    hostname: string | undefined;
    action: string | undefined;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    /** Override only for a trusted provider fixture or a controlled deployment endpoint. */
    siteverifyUrl?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
};
/** Creates a bounded Siteverify adapter; successful proof facts are not authorization. */
export declare function createTurnstileVerifier(config: TurnstileVerifierConfig): TurnstileVerifier;
