import handler from 'vinext/server/fetch-handler';
import { accountsConfig, httpOrigin } from '../features/config/env.ts';
import { isAccountServicePath, proxyAccountRequest } from '../features/proxy/account-proxy.ts';
import { applyLocaleParameter } from '../i18n/locale.ts';
import { trustedFormRequest } from '../features/auth/form-request.ts';

export default {
  async fetch(
    request: Request,
    env: Parameters<typeof handler.fetch>[1],
    context: Parameters<typeof handler.fetch>[2],
  ): Promise<Response> {
    if (isAccountServicePath(new URL(request.url).pathname)) {
      const config = accountsConfig();
      return proxyAccountRequest(request, {
        serviceOrigin: httpOrigin('ACCOUNT_SERVICE_ORIGIN', config.ACCOUNT_SERVICE_ORIGIN),
        publicOrigin: httpOrigin('ACCOUNT_BASE_URL', config.ACCOUNT_BASE_URL),
        countryFromHeader: config.ACCOUNTS_COUNTRY_FROM_HEADER,
      });
    }
    const localized = applyLocaleParameter(
      trustedFormRequest(request, accountsConfig().ACCOUNTS_COUNTRY_FROM_HEADER),
    );
    const response = await handler.fetch(localized.request, env, context);
    if (!localized.setCookie) return response;
    const headers = new Headers(response.headers);
    headers.append('set-cookie', localized.setCookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
