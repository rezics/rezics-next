import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ConsentCard } from './consent-card.tsx';
import { ConsentProblem } from './consent-problem.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';

const query = 'client_id=reader&scope=openid+profile+email+work%3Aread+offline_access+realm%3Aadopt&sig=abc';
const meta = {
  title: 'Accounts/Consent', component: ConsentCard,
  args: { oauthQuery: query, scopes: ['openid', 'profile', 'email', 'work:read', 'offline_access', 'realm:adopt'],
    user: { name: 'Ada Lovelace', email: 'ada@example.test', image: null },
    app: { name: 'Reader', logo: null, uri: 'https://reader.example', policy: 'https://reader.example/privacy',
      terms: 'https://reader.example/terms', unverified: false, redirectHost: 'reader.example' } },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
} satisfies Meta<typeof ConsentCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const allowed = fn();
export const Request: Story = {
  parameters: { account: { navigate: allowed } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Reader wants to access your REZICS Account' }))
      .toBeVisible();
    await expect(canvas.getByText('ada@example.test')).toBeVisible();
    for (const group of ['Know who you are', 'Work with your works', 'Other access', 'Keep access']) {
      await expect(canvas.getByRole('heading', { level: 3, name: group })).toBeVisible();
    }
    await expect(canvas.getByText('realm:adopt')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://reader.example/privacy');
    await userEvent.click(canvas.getByRole('button', { name: 'Allow' }));
    await expect(allowed).toHaveBeenCalledWith('https://app.example/callback?code=c');
  },
};

const denied = fn();
const answer = fn(async () => ({ ok: true as const, data: { redirect: 'https://app.example/callback?error=access_denied' } }));
export const Cancel: Story = {
  parameters: { account: { navigate: denied, api: { consent: answer } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel' }));
    await expect(answer).toHaveBeenCalledWith(false, query);
    await expect(denied).toHaveBeenCalledWith('https://app.example/callback?error=access_denied');
  },
};

const switched = fn();
export const SwitchAccount: Story = {
  parameters: { account: { navigate: switched } },
  async play({ canvasElement }) {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Not you? Switch account' }));
    await expect(switched).toHaveBeenCalledWith(`/sign-in?${query}`);
  },
};

export const Expired: Story = {
  parameters: { account: { api: { consent: async () => ({ ok: false, kind: 'expired-request', status: 400 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Allow' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This request has expired.');
  },
};

export const UnknownApp: Story = {
  args: { app: null, scopes: ['openid'] },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1,
      name: 'An app wants to access your REZICS Account' })).toBeVisible();
  },
};

export const Unverified: Story = {
  args: { app: { ...meta.args.app, name: 'REZICS', unverified: true,
    logo: 'https://unverified.example/logo.png', redirectHost: '127.0.0.1:49152' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Unverified app')).toBeVisible();
    await expect(canvas.getByText('REZICS has not verified this app’s identity.')).toBeVisible();
    await expect(canvas.getByText('127.0.0.1:49152')).toBeVisible();
    await expect(canvas.queryByRole('img')).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Terms of service' })).toBeNull();
  },
};

export const UnverifiedPhone: Story = { ...Unverified, globals: phone };
export const UnverifiedJapanesePhone: Story = { ...Unverified, globals: { locale: 'ja', ...phone },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('未確認のアプリ')).toBeVisible();
    await expect(canvas.getByText('127.0.0.1:49152')).toBeVisible();
  },
};

export const InvalidRequest: Story = {
  render: () => <ConsentProblem kind="invalid" />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'This request isn’t valid' })).toBeVisible();
  },
};

export const SignedOut: Story = {
  render: () => <ConsentProblem kind="signed-out" signIn={`/sign-in?${query}`} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/sign-in?${query}`);
  },
};

export const Unavailable: Story = {
  render: () => <ConsentProblem kind="unavailable" />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Your account is unavailable right now' }))
      .toBeVisible();
  },
};

export const Dark: Story = { ...Request, parameters: {}, play: UnknownApp.play, args: { ...UnknownApp.args }, globals: dark };
export const Phone: Story = { globals: phone,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('button', { name: 'Allow' })).toBeVisible();
  },
};
const japanese = { locale: 'ja' } as const;
const german = { locale: 'de' } as const;
const adopt = {
  ja: 'コミュニティの投稿を採用する',
  de: 'Community-Beiträge übernehmen',
};

export const Japanese: Story = {
  globals: japanese,
  args: { descriptions: { 'realm:adopt': adopt.ja } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1,
      name: 'Reader が REZICS アカウントへのアクセスを求めています' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '許可' })).toBeVisible();
    await expect(canvas.getByText(adopt.ja)).toBeVisible();
    await expect(canvas.queryByText('realm:adopt')).toBeNull();
  },
};

export const JapanesePhone: Story = { ...Japanese, globals: { ...japanese, ...phone } };

export const German: Story = {
  globals: german,
  args: { descriptions: { 'realm:adopt': adopt.de } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1,
      name: 'Reader möchte auf Ihren REZICS Account zugreifen' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Zulassen' })).toBeVisible();
    await expect(canvas.getByText(adopt.de)).toBeVisible();
  },
};

export const GermanPhone: Story = { ...German, globals: { ...german, ...phone } };

export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Reader 请求访问您的 REZICS 账号' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '允许' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 3, name: '识别您的身份' })).toBeVisible();
  },
};
