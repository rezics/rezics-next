'use client';

import { useLocale, useTranslation } from '../../i18n/client.ts';
import { policyHref, type PolicyVersion } from './policies.ts';

/** The exact versions a person accepts, each linking to the text the about site publishes for it. */
export function PolicyLinks({ policies, aboutOrigin }: { policies: readonly PolicyVersion[]; aboutOrigin: string }) {
  const { t } = useTranslation('auth');
  const locale = useLocale().current;
  const names = { terms: t.termsName, privacy: t.privacyName };
  return <span className="block">
    {policies.map(policy => <span key={policy.policyId} className="block">
      <a className="underline underline-offset-4" target="_blank" rel="noopener"
        href={policyHref(aboutOrigin, locale, policy.policyId)} data-digest={policy.versionDigest}>
        {names[policy.policyId]}</a>
      {' '}({t.policyEffective({ date: policy.effectiveDate })})</span>)}
    {locale === 'en' ? null : <span className="mt-1 block">{t.policiesInEnglish}</span>}
  </span>;
}
