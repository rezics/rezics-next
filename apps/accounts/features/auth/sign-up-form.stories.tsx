import { TURNSTILE_TEST_SITE_KEY } from './turnstile.tsx';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SignUpForm } from './sign-up-form.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';
import { turnstileFixture } from './turnstile.fixture.ts';
import { policyFixture } from './policies.fixture.ts';

const meta = {
  title: 'Accounts/Create account', component: SignUpForm, args: { turnstileSiteKey: TURNSTILE_TEST_SITE_KEY, next: '/', policies: policyFixture,
    aboutOrigin: 'https://rezics.example', country: 'US' },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
  beforeEach: () => turnstileFixture(),
} satisfies Meta<typeof SignUpForm>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement, password = 'long pass phrase', confirm = password, submit = true,
  birth = { month: '05', year: '1990' }, accept = true) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Name' }), 'Ada Lovelace');
  await userEvent.type(canvas.getByRole('textbox', { name: 'Email' }), 'ada@example.test');
  await userEvent.type(canvas.getByLabelText('Password'), password);
  await userEvent.type(canvas.getByLabelText('Confirm'), confirm);
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Month' }), birth.month);
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Year' }), birth.year);
  if (accept) await userEvent.click(canvas.getByRole('checkbox', { name: /I have read and accept/ }));
  if (submit) await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
  return canvas;
}

const created = fn();
export const Form: Story = {
  parameters: { account: { navigate: created } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Create your REZICS Account' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('Enter your name')).toBeVisible();
    await expect(canvas.getByText('Enter an email')).toBeVisible();
    await expect(canvas.getByText('Use 12 characters or more for your password')).toBeVisible();
    await expect(canvas.getByText('Choose your birth month and year')).toBeVisible();
    await expect(canvas.getByText('Accept the Terms and the Privacy Policy to create an account')).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('Password'));
    await fill(canvasElement);
    await expect(created).toHaveBeenCalledWith('/');
  },
};

export const PasswordsDiffer: Story = {
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement, 'long pass phrase', 'another phrase');
    await expect(canvas.getByText('Those passwords didn’t match. Try again.')).toBeVisible();
  },
};

export const CheckYourEmail: Story = {
  parameters: { account: { api: { signUp: async () => ({ ok: true, data: { verify: true } }) } } },
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(canvas.getByText(/If ada@example\.test can be used for a REZICS Account/)).toBeVisible();
  },
};

export const CouldNotCreate: Story = {
  parameters: { account: { api: { signUp: async () => ({ ok: false, kind: 'failed', status: 422 }) } } },
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    // The same words whether or not the email already has an account.
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'We couldn’t create an account with these details. If you already have one, sign in or reset your password.');
  },
};

const signedUp = fn(async () => ({ ok: true as const, data: { verify: true } }));
export const ForAnApp: Story = {
  args: { appName: 'Reader', oauthQuery: 'client_id=reader&sig=abc&ba_param=client_id',
    carry: 'client_id=reader&sig=abc&ba_param=client_id' },
  parameters: { account: { api: { signUp: signedUp } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Create your REZICS Account to continue to Reader')).toBeVisible();
    await fill(canvasElement);
    // The account keeps the page's language; verification returns to the app's request.
    await expect(signedUp).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en',
      carry: 'client_id=reader&sig=abc&ba_param=client_id' }));
    await expect(await canvas.findByRole('link', { name: 'Back to sign in' }))
      .toHaveAttribute('href', '/sign-in?client_id=reader&sig=abc&ba_param=client_id&sign_in=1');
  },
};

export const ForRezics: Story = {
  args: { appName: 'REZICS' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('One account for REZICS and everything that comes next')).toBeVisible();
  },
};

export const Dark: Story = { ...Form, globals: dark };
export const Phone: Story = { ...Form, globals: phone };
export const AwaitingChallenge: Story = {
  beforeEach: () => turnstileFixture('pending'),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement, 'long pass phrase', 'long pass phrase', false);
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(canvas.getByText('Security check')).toBeVisible();
  },
};
export const ChallengeUnavailable: Story = {
  beforeEach: () => turnstileFixture('error'),
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(
      'The security check is unavailable. Reload this page to try again.');
  },
};
export const MissingSiteKey: Story = {
  args: { turnstileSiteKey: undefined },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'The security check is unavailable. Reload this page to try again.');
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(canvas.queryByText('Security check')).not.toBeInTheDocument();
  },
};
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '创建您的 REZICS 账号' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '下一步' }));
    await expect(canvas.getByText('请输入您的姓名')).toBeVisible();
  },
};

const refused = (kind: 'market-minimum-age' | 'market-unavailable' | 'invalid-birth-month' | 'policy-acceptance-required',
  minimumAge?: number) => ({ account: { api: { signUp: async () => ({ ok: false as const, kind, status: 400, minimumAge }) } } });

export const PoliciesAreTheExactVersions: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const terms = await canvas.findByRole('link', { name: 'Terms of Service' });
    await expect(terms).toHaveAttribute('href', 'https://rezics.example/en/legal/terms/');
    await expect(terms).toHaveAttribute('data-digest', 'a'.repeat(64));
    await expect(canvas.getByRole('link', { name: 'Privacy Policy' }))
      .toHaveAttribute('href', 'https://rezics.example/en/legal/privacy/');
    await expect(canvas.getAllByText(/effective 2026-10-01/)).toHaveLength(2);
    await expect(canvas.getByText('Region we detected: United States')).toBeVisible();
  },
};

const sent = fn(async () => ({ ok: true as const, data: { verify: true } }));
export const SendsTheDeclarationsAndAcceptedDigests: Story = {
  parameters: { account: { api: { signUp: sent } } },
  async play({ canvasElement }) {
    await fill(canvasElement);
    await expect(sent).toHaveBeenCalledWith(expect.objectContaining({ birthMonth: '1990-05',
      acceptedPolicies: [{ policyId: 'terms', versionDigest: 'a'.repeat(64) },
        { policyId: 'privacy', versionDigest: 'b'.repeat(64) }] }));
  },
};

export const RefusedBelowTheMinimumAgeInKorea: Story = {
  args: { country: 'KR' },
  parameters: refused('market-minimum-age', 14),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'In South Korea, REZICS accounts are for people aged 14 or older. This is a rule about age, not a judgment of you');
  },
};

export const RefusedBelowTheMinimumAgeInTheEea: Story = {
  args: { country: 'DE' },
  parameters: refused('market-minimum-age', 16),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('In Germany, REZICS accounts are for people aged 16 or older.');
  },
};

export const RegionNotOpen: Story = {
  args: { country: 'CN' },
  parameters: refused('market-unavailable'),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('REZICS is not creating accounts in China yet. Nothing was saved.');
  },
};

export const UnknownRegion: Story = {
  args: { country: null },
  parameters: refused('market-minimum-age', 16),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(canvas.getByText('We could not detect your region, so the strictest minimum age applies.')).toBeVisible();
    await expect(await canvas.findByRole('alert')).toHaveTextContent('In your region, REZICS accounts are for people aged 16');
  },
};

export const PoliciesChangedWhileFilling: Story = {
  parameters: refused('policy-acceptance-required'),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('The policies changed while you were here.');
  },
};

export const PoliciesUnavailable: Story = {
  args: { policies: undefined },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('sign-up is paused');
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled();
  },
};

export const NeedsTheBirthMonthAndAcceptance: Story = {
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement, 'long pass phrase', 'long pass phrase', true, { month: '', year: '' }, false);
    await expect(canvas.getByText('Choose your birth month and year')).toBeVisible();
    await expect(canvas.getByText('Accept the Terms and the Privacy Policy to create an account')).toBeVisible();
  },
};
export const PhoneWithRefusal: Story = {
  args: { country: 'KR' },
  globals: phone,
  parameters: refused('market-minimum-age', 14),
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};
