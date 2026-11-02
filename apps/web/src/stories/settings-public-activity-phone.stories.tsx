import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import { createProfileStoryIO } from '../kernel/fake/settings-profile';
import { m } from '../paraglide/messages.js';
import { ProfileCard } from '../settings/profile';
import { PublicViewsCard } from '../settings/public-views';
import type { ProfileValues } from '../settings/profile-data';
import { ProfileEditor, type ProfileAttempt } from '../settings/profile-write';
import { ProfileNavigation } from '../settings/profile-navigation';

type RecoveryStoryProps = {
  onConfirmed: (profile: ProfileValues) => void;
  onEditor: (editor: ProfileEditor) => void;
  onPending: (release: () => void) => void;
  onSave: (attempt: ProfileAttempt) => void;
};

function ProfileActivity({ onConfirmed, onEditor, onPending, onSave }: RecoveryStoryProps) {
  const [editor] = useState(() => {
    const io = createProfileStoryIO('normal');
    let writes = 0;
    return new ProfileEditor({
      ...io,
      save: async (attempt) => {
        onSave(attempt);
        writes += 1;
        if (writes === 1) return { ok: false, status: 409, message: '' };
        if (writes === 2) await new Promise<void>((resolve) => onPending(resolve));
        return io.save(attempt);
      },
      confirmed: onConfirmed,
    });
  });

  useEffect(() => {
    onEditor(editor);
    void editor.reload();
  }, [editor, onEditor]);

  return (
    <ProfileNavigation editor={editor}>
      <div className="mx-auto grid w-full max-w-sm gap-4">
        <section aria-label={m.settings_profile_heading()}>
          <ProfileCard editor={editor} />
        </section>
        <section aria-label={m.settings_public_activity_heading()}>
          <PublicViewsCard editor={editor} />
        </section>
      </div>
    </ProfileNavigation>
  );
}

function Example(props: RecoveryStoryProps) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const settings = createRoute({
      getParentRoute: () => root,
      path: '/settings',
      component: () => <ProfileActivity {...props} />,
    });
    return createRouter({
      routeTree: root.addChildren([settings]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
  }, [props.onConfirmed, props.onEditor, props.onPending, props.onSave]);

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Patterns/Account/Profile',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A phone recovery journey through the actual profile and public-activity cards, sharing one ProfileEditor and confirming the views-only resubmission while an unrelated profile draft remains unsaved.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RefusedSaveRecovery: Story = {
  args: { onConfirmed: fn(), onEditor: fn(), onPending: fn(), onSave: fn() },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const onEditor = mocked(args.onEditor);
    const onPending = mocked(args.onPending);
    const onSave = mocked(args.onSave);
    const displayName = await canvas.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(displayName);
    await userEvent.type(displayName, 'Unrelated profile draft');

    const reviews = canvas.getByRole('switch', { name: m.settings_public_reviews() });
    await userEvent.click(reviews);
    await expect(onSave).not.toHaveBeenCalled();
    await expect(canvas.getByText(m.settings_public_activity_unsaved())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.settings_profile_save_activity() }));
    await canvas.findByText(m.settings_public_activity_conflict());
    await expect(reviews).not.toBeChecked();
    await expect(displayName).toHaveValue('Unrelated profile draft');
    await expect(onSave).toHaveBeenCalledTimes(1);

    const firstAttempt = onSave.mock.calls[0]?.[0];
    const editor = onEditor.mock.calls.at(-1)?.[0];
    if (!firstAttempt || !editor) throw new Error('The refused public-activity attempt was not observed.');
    await expect(editor.snapshot().phase).toBe('refused');
    await expect(editor.snapshot().attempt).toBeNull();
    await expect(firstAttempt).toMatchObject({
      scope: 'views',
      patch: { publicViews: { reviews: false } },
    });

    const saveActivity = canvas.getByRole('button', { name: m.settings_profile_save_activity() });
    await expect(saveActivity).toHaveClass('min-h-11');
    await expect(saveActivity).toHaveClass('h-auto');
    await expect(saveActivity).toHaveClass('w-full');
    await expect(saveActivity).toHaveClass('max-w-sm');
    await expect(saveActivity).toHaveClass('whitespace-normal');
    await expect(saveActivity).toHaveClass('break-words');
    await expect(saveActivity).toHaveClass('mt-2');
    await expect(saveActivity).toHaveClass('focus-visible:ring-3');

    saveActivity.focus();
    await expect(saveActivity).toHaveFocus();
    await expect(onSave).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.settings_saving());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const secondAttempt = onSave.mock.calls[1]?.[0];
    if (!secondAttempt) throw new Error('The explicit public-activity resubmission was not observed.');
    await expect(secondAttempt.scope).toBe('views');
    await expect(secondAttempt.patch).toEqual({ publicViews: { reviews: false } });
    await expect(secondAttempt.idempotencyKey).not.toBe(firstAttempt.idempotencyKey);

    await editor.submit('views');
    await expect(onSave).toHaveBeenCalledTimes(2);
    await expect(editor.snapshot().attempt?.idempotencyKey).toBe(secondAttempt.idempotencyKey);

    const release = onPending.mock.calls.at(-1)?.[0];
    if (!release) throw new Error('The pending public-activity save has no release control.');
    release();
    await waitFor(() => expect(args.onConfirmed).toHaveBeenCalledTimes(2));
    await expect(args.onConfirmed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayName: 'Avery Reader',
        publicViews: { posts: true, reviews: false, collections: true, realms: false },
      }),
    );
    await expect(displayName).toHaveValue('Unrelated profile draft');
    await expect(canvas.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();
    await expect(canvas.getByRole('switch', { name: m.settings_public_reviews() })).not.toBeChecked();
    await expect(onSave).toHaveBeenCalledTimes(2);
    await expect(canvas.queryByRole('button', { name: m.settings_profile_save_activity() })).toBeNull();
  },
};
