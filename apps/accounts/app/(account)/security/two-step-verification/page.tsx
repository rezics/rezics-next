import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { SectionHeading } from '../../../../features/account/account-shell.tsx';
import { TwoStepVerification } from '../../../../features/account/two-step.tsx';
import { ReadStatePanel } from '../../../../features/shell/state-panel.tsx';

export default async function TwoStepVerificationPage() {
  return renderAccountPage('security', ({ methods, t }) => methods.status === 'ok'
    ? <TwoStepVerification totp={methods.data.totp} hasPassword={methods.data.password} />
    : <><SectionHeading back={{ href: '/security', label: t.security }} title={t.methodTwoStep} />
      <ReadStatePanel status={methods.status} next="/security/two-step-verification" /></>,
  '/security/two-step-verification');
}
