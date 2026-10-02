import { chooseOption } from '../shell/select.fixture.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, fireEvent } from 'storybook/test';
import { ContentSettings } from './content-settings.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { phone, dark } from '../../.storybook/variants.ts';
import type { ContentPreferences } from '../api/content-preferences.ts';

const unknown: ContentPreferences = { revision: 0, birthDate: null, country: null, birthdayPublic: false,
  publicId: null, age: 'unknown', accountEligible: true, adultAvailable: false,
  categories: { general: true, r15: false, r18: false, r18g: false } };
const adult: ContentPreferences = { ...unknown, birthDate: '1990-01-01', country: 'US', age: 'adult', adultAvailable: true,
  categories: { general: true, r15: true, r18: false, r18g: false } };
const meta = { title: 'Accounts/Account centre/Birthday and content', component: ContentSettings,
  args: { initial: { status: 'ok', data: unknown } },
  decorators: [Story => <AccountFrame section="personal-info"><Story /></AccountFrame>],
} satisfies Meta<typeof ContentSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

const generalOff = fn(async () => ({ ok: true as const, data: { ...unknown, revision: 1,
  categories: { ...unknown.categories, general: false } } }));
export const IndependentGeneralAndCancel: Story = {
  parameters: { account: { api: { setContentPreferences: generalOff } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('switch', { name: 'General' }));
    await expect(generalOff).toHaveBeenCalledWith({ expectedRevision: 0, categories: { general: false } });
    await expect(canvas.queryByLabelText('Country or region')).toBeNull();
    await userEvent.click(canvas.getByRole('switch', { name: 'R15' }));
    await expect(canvas.getByText(/Enter your birthday to check/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(canvas.getByRole('switch', { name: 'R15' })).not.toBeChecked();
    await expect(canvas.getByRole('switch', { name: 'General' })).not.toBeChecked();
    await expect(generalOff).toHaveBeenCalledTimes(1);
  },
};

const learned = fn(async () => ({ ok: true as const, data: { ...adult, revision: 1 } }));
export const BirthdayFromAnotherFlow: Story = {
  parameters: { account: { api: { setContentPreferences: learned } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit · Birthday' }));
    await fireEvent.change(canvas.getByLabelText('Birthday'), { target: { value: '1990-01-01' } });
    await chooseOption(canvas.getByRole('combobox', { name: 'Country or region' }), 'US');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(learned).toHaveBeenCalledWith({ expectedRevision: 0, birthDate: '1990-01-01', country: 'US' });
    await expect(canvas.getByRole('switch', { name: 'R15' })).toBeChecked();
    await expect(canvas.getByRole('switch', { name: 'R18' })).not.toBeChecked();
    await expect(canvas.getByRole('switch', { name: 'Make birthday public' })).not.toBeChecked();
  },
};

const sexual = fn(async () => ({ ok: true as const, data: { ...adult, revision: 1,
  categories: { ...adult.categories, r18: true } } }));
export const AdultCategoriesAreSeparate: Story = {
  args: { initial: { status: 'ok', data: adult } },
  parameters: { account: { api: { setContentPreferences: sexual } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('switch', { name: /^R18$/ }));
    await expect(sexual).toHaveBeenCalledWith({ expectedRevision: 0, categories: { r18: true } });
    await expect(canvas.getByRole('switch', { name: /^R18$/ })).toBeChecked();
    await expect(canvas.getByRole('switch', { name: 'R18G' })).not.toBeChecked();
  },
};
export const PublicBirthday: Story = {
  args: { initial: { status: 'ok', data: { ...adult, birthdayPublic: true,
    publicId: '00000000-0000-4000-8000-000000000001' } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'View public birthday' }))
      .toHaveAttribute('href', '/birthday/00000000-0000-4000-8000-000000000001');
    await expect(canvas.getByText(/including the year/)).toBeVisible();
  },
};
export const BirthdayPrompt: Story = {
  async play({ canvasElement }) {
    await userEvent.click(await within(canvasElement).findByRole('switch', { name: 'R15' }));
  },
};
export const DeniedAge: Story = {
  args: { initial: { status: 'ok', data: adult } },
  parameters: { account: { api: { setContentPreferences: async () => ({ ok: false, kind: 'age-ineligible', status: 403 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('switch', { name: /^R18$/ }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('You do not meet the age requirement');
    await expect(canvas.getByRole('switch', { name: /^R18$/ })).not.toBeChecked();
  },
};
export const Unavailable: Story = { args: { initial: { status: 'unavailable' } } };
export const Phone: Story = { ...BirthdayPrompt, globals: phone };
export const Dark: Story = { ...PublicBirthday, globals: dark };
export const TraditionalChinese: Story = { globals: { locale: 'zh-Hant' } };
