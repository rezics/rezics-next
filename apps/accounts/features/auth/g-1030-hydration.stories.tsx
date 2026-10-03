import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Checkbox } from '@rezics/ui/checkbox';
import { Button } from '@rezics/ui/button';
import { useEffect, useRef, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { EmailField, NameField, PasswordField, CodeField } from './fields.tsx';

function NativeFields({ initialAccepted = false }: { initialAccepted?: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState(initialAccepted);
  const [submitted, setSubmitted] = useState('');
  useEffect(() => {
    document.querySelector('[data-g1030-island]')?.setAttribute('data-ready', 'true');
  }, []);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        setSubmitted(JSON.stringify(Object.fromEntries(values)));
        setPassword('');
      }}
    >
      <NameField label="Display name" value={name} onChange={setName} />
      <EmailField label="Email" value={email} onChange={setEmail} />
      <PasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        visibilityLabel="Show password"
      />
      <CodeField label="Enter code" value={code} onChange={setCode} />
      <Checkbox
        name="accept-policies"
        checked={accepted}
        onCheckedChange={({ checked }) => setAccepted(checked === true)}
      >
        Accept policies
      </Checkbox>
      <output aria-label="Adopted email">{email}</output>
      <Button type="submit">Submit fields</Button>
      <output aria-label="Submitted fields">{submitted}</output>
    </form>
  );
}

/** The first form is actual SSR markup with no handlers. Hydration is released
 * only after the story has typed and clicked; a fully mounted form cannot prove
 * that user input survives hydration. */
function HydrationFixture({ initialAccepted = false }: { initialAccepted?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const root = useRef<Root | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (container.current) {
      container.current.innerHTML = renderToString(
        <NativeFields initialAccepted={initialAccepted} />,
        { identifierPrefix: 'g1030-' },
      );
      setReady(true);
    }
    return () => {
      root.current?.unmount();
    };
  }, [initialAccepted]);
  return (
    <div className="mx-auto grid max-w-lg gap-5 p-6">
      <div ref={container} data-g1030-island />
      <Button
        disabled={!ready || hydrated}
        onClick={() => {
          if (!container.current) return;
          root.current = hydrateRoot(
            container.current,
            <NativeFields initialAccepted={initialAccepted} />,
            { identifierPrefix: 'g1030-' },
          );
          setHydrated(true);
        }}
      >
        Release hydration
      </Button>
    </div>
  );
}

const meta = {
  title: 'Accounts/Hydration preservation',
  component: HydrationFixture,
} satisfies Meta<typeof HydrationFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TypingAndCheckingBeforeHydration: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Release hydration' })).toBeEnabled(),
    );
    await userEvent.type(canvas.getByLabelText('Display name'), '林美玲');
    await userEvent.type(canvas.getByLabelText('Email'), 'reader@example.test');
    await userEvent.type(
      canvas.getByLabelText('Password', { exact: true }),
      'typed before hydration',
    );
    await userEvent.type(canvas.getByLabelText('Enter code'), '123456');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Accept policies' }));
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).toBeChecked();
    const indicators = canvasElement.querySelectorAll('[data-slot="checkbox-indicator"]');
    await expect(indicators[0]).toBeVisible();
    await expect(indicators[1]).not.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Release hydration' }));
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-g1030-island]')).toHaveAttribute(
        'data-ready',
        'true',
      ),
    );
    await expect(canvas.getByLabelText('Display name')).toHaveValue('林美玲');
    await expect(canvas.getByLabelText('Email')).toHaveValue('reader@example.test');
    await expect(canvas.getByLabelText('Password', { exact: true })).toHaveValue(
      'typed before hydration',
    );
    await expect(canvas.getByLabelText('Enter code')).toHaveValue('123456');
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).toBeChecked();
    await expect(canvas.getByLabelText('Adopted email')).toHaveTextContent('reader@example.test');
    // A second edit and a later rerender must not restore the initial values.
    await userEvent.type(canvas.getByLabelText('Display name'), ' · Mei');
    await userEvent.click(canvas.getByRole('button', { name: 'Submit fields' }));
    await expect(canvas.getByLabelText('Submitted fields')).toHaveTextContent(
      '"name":"林美玲 · Mei"',
    );
    await expect(canvas.getByLabelText('Submitted fields')).toHaveTextContent(
      '"accept-policies":"on"',
    );
    await expect(canvas.getByLabelText('Password', { exact: true })).toHaveValue('');
  },
};

export const ClearingBeforeHydration: Story = {
  args: { initialAccepted: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Release hydration' })).toBeEnabled(),
    );
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).toBeChecked();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Accept policies' }));
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).not.toBeChecked();
    await expect(canvasElement.querySelector('[data-slot="checkbox-indicator"]')).not.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Release hydration' }));
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-g1030-island]')).toHaveAttribute(
        'data-ready',
        'true',
      ),
    );
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).not.toBeChecked();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Accept policies' }));
    await expect(canvas.getByRole('checkbox', { name: 'Accept policies' })).toBeChecked();
  },
};
