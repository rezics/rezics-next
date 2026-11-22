import type { MinecraftSignIn } from '@rezics/launcher-contract';
import { MicrosoftAuthenticator, MicrosoftMinecraftXboxLoginError } from '@xmcl/user';
import { setTimeout } from 'node:timers/promises';
import * as v from 'valibot';

const deviceEndpoint = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'XboxLive.signin offline_access';
const verificationHosts = new Set(['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com']);
const verificationPaths = new Set(['/link', '/devicelogin', '/common/oauth2/deviceauth']);
const seconds = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
export const privateToken = v.pipe(v.string(), v.minLength(1), v.maxLength(32_768));
const deviceResponse = v.object({
  device_code: privateToken,
  user_code: v.pipe(v.string(), v.regex(/^[a-z\d-]{1,64}$/iu)),
  verification_uri: v.string(),
  expires_in: v.pipe(seconds, v.maxValue(3600)),
  interval: v.pipe(seconds, v.maxValue(60)),
});
const oauthToken = v.object({ access_token: privateToken, refresh_token: v.optional(privateToken) });
const oauthError = v.object({ error: v.string() });
const xboxToken = v.object({ Token: privateToken });
const xboxIdentity = v.object({
  Token: privateToken,
  DisplayClaims: v.object({ xui: v.tupleWithRest([v.object({ uhs: privateToken })], v.unknown()) }),
});
const minecraftToken = v.object({ access_token: privateToken, expires_in: v.pipe(seconds, v.maxValue(86_400)) });
const ownershipResponse = v.object({ items: v.array(v.object({ name: v.string() })) });
const identityField = v.pipe(v.string(), v.regex(/^[a-z\d_-]{1,64}$/iu));
export const minecraftIdentity = v.object({ id: identityField, name: identityField });

export type AuthorizedProfile = {
  profile: v.InferOutput<typeof minecraftIdentity>;
  token: string;
  expiresAt: number;
  refresh?: string | undefined;
};

type Device = MinecraftSignIn & { deviceCode: string; interval: number };
const messages = {
  configuration: 'Configure the approved REZICS Microsoft application to sign in to Minecraft.',
  application: 'Microsoft or Minecraft Services denied the REZICS application. Verify its Minecraft authorization.',
  xbox: 'Xbox could not authorize this Microsoft account. Check its Xbox profile and family settings.',
  entitlement: 'This account does not have a Minecraft Java entitlement.',
  profile: 'This account has no Minecraft Java player profile. Create the profile and try again.',
  denied: 'Microsoft sign-in was denied. Start again and approve the request.',
  expired: 'Microsoft sign-in expired. Sign in again.',
  network: 'Microsoft or Minecraft Services could not be reached. Check your connection and retry.',
  response: 'Microsoft or Minecraft Services returned an unexpected sign-in response. Try again.',
  cancelled: 'Microsoft sign-in was cancelled.',
} as const;

export class AuthFailure extends Error {
  constructor(readonly kind: keyof typeof messages) {
    super(messages[kind]);
  }
}

function checked<S extends v.GenericSchema>(schema: S, value: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new AuthFailure('response');
  return result.output;
}

function oauthFailure(code: string): AuthFailure {
  switch (code) {
    case 'invalid_client':
    case 'unauthorized_client':
    case 'invalid_scope':
      return new AuthFailure('application');
    case 'authorization_declined':
    case 'access_denied':
      return new AuthFailure('denied');
    case 'invalid_grant':
    case 'expired_token':
    case 'bad_verification_code':
    case 'interaction_required':
    case 'consent_required':
      return new AuthFailure('expired');
    case 'temporarily_unavailable':
    case 'server_error':
      return new AuthFailure('network');
    default:
      return new AuthFailure('response');
  }
}

async function boundedResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return response;
  const decoder = new TextDecoder();
  try {
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 131_072) throw new AuthFailure('response');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return new Response(text + decoder.decode(), { status: response.status, headers: response.headers });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class MinecraftAuthProvider {
  constructor(
    private readonly clientId: string | undefined,
    private readonly fetcher: typeof fetch,
  ) {}

  private async request(input: Parameters<typeof fetch>[0], init: RequestInit, signal: AbortSignal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      const response = await this.fetcher(input, { ...init, signal: requestSignal, redirect: 'error' });
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        await response.body?.cancel();
        throw new AuthFailure('network');
      }
      return await boundedResponse(response);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('network');
    }
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AuthFailure('response');
    }
  }

  private async form(path: 'devicecode' | 'token', params: Record<string, string>, signal: AbortSignal) {
    if (!this.clientId) throw new AuthFailure('configuration');
    const response = await this.request(
      `${deviceEndpoint}/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, ...params }),
      },
      signal,
    );
    return { ok: response.ok, data: await this.json(response) };
  }

  async begin(signal: AbortSignal): Promise<Device> {
    const { ok, data } = await this.form('devicecode', { scope }, signal);
    if (!ok) throw oauthFailure(checked(oauthError, data).error);
    const device = checked(deviceResponse, data);
    const url = URL.parse(device.verification_uri);
    if (
      url?.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !verificationHosts.has(url.hostname) ||
      !verificationPaths.has(url.pathname)
    ) {
      throw new AuthFailure('response');
    }
    return {
      url: url.href,
      code: device.user_code,
      expiresAt: Date.now() + device.expires_in * 1000,
      deviceCode: device.device_code,
      interval: device.interval,
    };
  }

  async complete(device: Device, cancellation: AbortSignal): Promise<AuthorizedProfile> {
    const deadline = AbortSignal.timeout(Math.max(1, device.expiresAt - Date.now()));
    const signal = AbortSignal.any([deadline, cancellation]);
    try {
      let interval = device.interval;
      while (Date.now() < device.expiresAt) {
        await setTimeout(interval * 1000, undefined, { signal });
        const { ok, data } = await this.form(
          'token',
          { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.deviceCode },
          signal,
        );
        if (ok) return await this.exchange(checked(oauthToken, data), signal);
        const { error } = checked(oauthError, data);
        if (error === 'authorization_pending') continue;
        if (error === 'slow_down') interval += 5;
        else throw oauthFailure(error);
      }
      throw new AuthFailure('expired');
    } catch (error) {
      if (cancellation.aborted) throw new AuthFailure('cancelled');
      if (deadline.aborted) throw new AuthFailure('expired');
      throw error;
    }
  }

  async refresh(refresh: string, signal: AbortSignal) {
    try {
      const { ok, data } = await this.form(
        'token',
        { grant_type: 'refresh_token', refresh_token: refresh, scope },
        signal,
      );
      if (!ok) throw oauthFailure(checked(oauthError, data).error);
      const signedIn = await this.exchange(checked(oauthToken, data), signal);
      return { ...signedIn, refresh: signedIn.refresh ?? refresh };
    } catch (error) {
      if (signal.aborted) throw new AuthFailure('network');
      throw error;
    }
  }

  private async exchange(token: v.InferOutput<typeof oauthToken>, signal: AbortSignal): Promise<AuthorizedProfile> {
    const fetch = ((input, init) => this.request(input, init ?? {}, signal)) as typeof globalThis.fetch;
    const authenticator = new MicrosoftAuthenticator({ fetch });
    let xbox: v.InferOutput<typeof xboxIdentity>;
    try {
      const xbl = checked(xboxToken, await authenticator.authenticateXboxLive(token.access_token, signal));
      xbox = checked(
        xboxIdentity,
        await authenticator.authorizeXboxLive(xbl.Token, 'rp://api.minecraftservices.com/', signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('xbox');
    }

    let minecraft: v.InferOutput<typeof minecraftToken>;
    try {
      minecraft = checked(
        minecraftToken,
        await authenticator.loginMinecraftWithXBox(xbox.DisplayClaims.xui[0].uhs, xbox.Token, signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AuthFailure) throw error;
      if (error instanceof MicrosoftMinecraftXboxLoginError && error.status === 403)
        throw new AuthFailure('application');
      throw new AuthFailure('denied');
    }

    const ownership = await this.minecraftData('/entitlements/mcstore', minecraft.access_token, signal);
    if (
      !checked(ownershipResponse, ownership).items.some(
        ({ name }) => name === 'game_minecraft' || name === 'product_minecraft',
      )
    ) {
      throw new AuthFailure('entitlement');
    }
    const profile = checked(
      minecraftIdentity,
      await this.minecraftData('/minecraft/profile', minecraft.access_token, signal),
    );
    return {
      profile,
      token: minecraft.access_token,
      expiresAt: Date.now() + minecraft.expires_in * 1000,
      refresh: token.refresh_token,
    };
  }

  private async minecraftData(
    path: '/entitlements/mcstore' | '/minecraft/profile',
    token: string,
    signal: AbortSignal,
  ) {
    const response = await this.request(
      `https://api.minecraftservices.com${path}`,
      { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
      signal,
    );
    if (response.ok) return this.json(response);
    await response.body?.cancel();
    if (path === '/minecraft/profile' && response.status === 404) throw new AuthFailure('profile');
    if (response.status === 401 || response.status === 403) throw new AuthFailure('denied');
    throw new AuthFailure('response');
  }
}
