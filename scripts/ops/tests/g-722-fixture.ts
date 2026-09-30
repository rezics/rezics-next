import { productionSpecs } from '../production-env.ts';

/** Synthetic complete deployment input; no real credential or development fixture. */
export function productionExample(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const spec of Object.values(productionSpecs))
    for (const [name, validator] of Object.entries(spec)) {
      if (validator.default !== undefined) result[name] = String(validator.default);
      else if (name.endsWith('_DATABASE_URL') || name === 'OWNER_RELOCATION_TARGET_URL')
        result[name] = 'postgres://owner:8d4cb67658b2d230@postgres.internal/owner';
      else if (/URL|ORIGIN|RESOURCE|ENDPOINT|ISSUER/.test(name))
        result[name] = 'https://service.rezics.com';
      else if (/PORT$/.test(name)) result[name] = '3001';
      else if (/DIRECTORY/.test(name)) result[name] = '/var/lib/rezics/objects';
      else if (/EPOCH/.test(name)) result[name] = '1';
      else result[name] = '8d4cb67658b2d230c437b8a97c2757e18d4cb67658b2d230c437b8a97c2757e1';
    }
  delete result.MAIN_OPEN_LIBRARY_FIXTURE_ROOT;
  result.ACCOUNT_SMTP_HOST = 'smtp.rezics.com';
  result.ACCOUNT_EMAIL_FROM = 'REZICS <accounts@rezics.com>';
  result.ACCOUNT_SMTP_REQUIRE_TLS = 'true';
  result.MAIN_ORIGIN = 'https://main.rezics.com';
  result.ACCOUNT_ORIGIN = 'https://accounts.rezics.com';
  result.ACCOUNT_SERVICE_ORIGIN = 'https://account.rezics.com';
  result.ACCOUNT_BASE_URL = 'https://accounts.rezics.com';
  result.WEB_ORIGIN = 'https://rezics.com';
  result.MAIN_RESOURCE = result.ACCOUNT_MAIN_RESOURCE = 'https://main.rezics.com';
  result.FUSEKI_TITLE_ADMISSION_KEY =
    '5db75dc8f93220c9a68776fc8b1f3c3c5db75dc8f93220c9a68776fc8b1f3c3c';
  return result;
}
