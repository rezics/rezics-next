import type { Meta, StoryObj } from '@storybook/react-vite';
import { act, type Dispatch, type SetStateAction, useState } from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../test/focus.ts';
import { dismissed, highlighted } from '../test/waits.ts';
import { settled, withSurface } from '../stories/support.tsx';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentActions } from './content-actions.tsx';
import type { ReportSubmission } from './report-dialog.tsx';

const meta = {
  title: 'Components/Content Actions',
  component: ContentActions,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: {
    onCopyLink: fn(),
    onReport: fn(async () => undefined),
    ownsContent: false,
    verified: true,
  },
  parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
} satisfies Meta<typeof ContentActions>;
export default meta;
type Story = StoryObj<typeof meta>;

const StrangerActions = () => (
  <ContentActions
    onCopyLink={fn()}
    onReport={fn(async () => undefined)}
    ownsContent={false}
    verification={
      <div aria-label="Human verification" role="group">
        Complete the verification challenge
      </div>
    }
    verified
  />
);

interface DeferredResult {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function deferredResult(): DeferredResult {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ownerActions = {
  copy: fn(),
  edit: fn(),
  delete: fn(async () => undefined),
  pin: fn(),
  report: fn(async (_report: ReportSubmission) => undefined),
  reportOpenChange: fn(),
  deleteRequests: [] as DeferredResult[],
  reportRequests: [] as { report: ReportSubmission; result: DeferredResult }[],
  controls: null as null | {
    setDeleteAvailable: Dispatch<SetStateAction<boolean>>;
    setOwner: Dispatch<SetStateAction<boolean>>;
    setActionsMounted: Dispatch<SetStateAction<boolean>>;
    setParentReportOpen: Dispatch<SetStateAction<boolean>>;
    rerender: Dispatch<SetStateAction<number>>;
  },
};

const OwnerActionsDemo = () => {
  const [ownsContent, setOwner] = useState(true);
  const [deleteAvailable, setDeleteAvailable] = useState(true);
  const [actionsMounted, setActionsMounted] = useState(true);
  const [reportOpen, setParentReportOpen] = useState(false);
  const [verified, setVerified] = useState(false);
  const [parentRender, rerender] = useState(0);
  ownerActions.controls = {
    setDeleteAvailable,
    setOwner,
    setActionsMounted,
    setParentReportOpen,
    rerender,
  };

  const onDelete = async () => {
    ownerActions.delete();
    const result = deferredResult();
    ownerActions.deleteRequests.push(result);
    return result.promise;
  };
  const onReport = async (report: ReportSubmission) => {
    ownerActions.report(report);
    const result = deferredResult();
    ownerActions.reportRequests.push({ report, result });
    return result.promise;
  };

  return (
    <div aria-label={`Parent render ${parentRender}`}>
      {actionsMounted ? (
        ownsContent ? (
          <ContentActions
            onCopyLink={() => ownerActions.copy()}
            onDelete={deleteAvailable ? onDelete : undefined}
            onEdit={() => ownerActions.edit()}
            extraEntries={[{ type: 'item', label: 'Pin Collection', onSelect: () => ownerActions.pin() }]}
            ownsContent
          />
        ) : (
          <ContentActions
            onCopyLink={() => ownerActions.copy()}
            onReport={onReport}
            ownsContent={false}
            verified={verified}
            verification={
              <div aria-label="Human verification challenge" role="group">
                <Button onClick={() => setVerified(true)} size="sm" type="button" variant="outline">
                  Complete verification
                </Button>
              </div>
            }
            maxDetails={40}
            reportOpen={reportOpen}
            onReportOpenChange={(open) => {
              ownerActions.reportOpenChange(open);
              setParentReportOpen(open);
            }}
          />
        )
      ) : null}
    </div>
  );
};

export const MenuKeyboard: Story = {
  args: {
    onCopyLink: fn(),
    onReport: fn(async () => undefined),
    ownsContent: false,
    verified: true,
  },
  render: () => <StrangerActions />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await settled(await screen.findByRole('menu'));
    await highlighted(() => within(menu).getAllByRole('menuitem')[0]!);
    // A key pressed before the menu takes focus goes to the trigger and is lost.
    await waitForFocus([menu, ...within(menu).getAllByRole('menuitem')]);
    await userEvent.keyboard('{End}');
    await highlighted(() => within(menu).getAllByRole('menuitem').at(-1)!);
    await userEvent.keyboard('{Enter}');

    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const illegal = within(dialog).getByRole('radio', { name: 'Illegal activity' });
    await expect(illegal).toHaveAccessibleDescription('This content may break the law.');
    await userEvent.click(illegal);
    await expect(within(dialog).getByRole('textbox', { name: 'Additional details' })).toBeRequired();
    await expect(within(dialog).getByRole('group', { name: 'Human verification' })).toBeVisible();
    await waitFor(() => expect(menu).not.toBeInTheDocument());
  },
};
export const MenuOpenPhone: Story = {
  args: { onCopyLink: fn(), onReport: fn(async () => undefined), ownsContent: false, verified: true },
  render: () => <StrangerActions />,
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    await expect(await screen.findByRole('dialog')).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Report' })).toBeVisible();
  },
};

export const OwnerActions: Story = {
  args: {
    onCopyLink: fn(),
    onDelete: fn(async () => undefined),
    onEdit: fn(),
    ownsContent: true,
  },
  render: () => <OwnerActionsDemo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    ownerActions.copy.mockClear();
    ownerActions.edit.mockClear();
    ownerActions.delete.mockClear();
    ownerActions.pin.mockClear();
    ownerActions.report.mockClear();
    ownerActions.reportOpenChange.mockClear();
    ownerActions.deleteRequests.length = 0;
    ownerActions.reportRequests.length = 0;
    let deleteDialogCloseCount = 0;
    let reportDialogCloseCount = 0;
    const controls = () => {
      if (!ownerActions.controls) throw new Error('The mounted ContentActions parent controls are unavailable.');
      return ownerActions.controls;
    };
    const openDelete = async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
      const menu = await settled(await screen.findByRole('menu'));
      await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
      return settled(await screen.findByRole('alertdialog', { name: 'Delete this content?' }));
    };
    const startDelete = async (confirmation: HTMLElement) => {
      const button = within(confirmation).getByRole('button', { name: 'Delete content' });
      await userEvent.click(button);
      await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    };
    const finishDelete = async (
      index: number,
      outcome: 'resolve' | 'reject',
      error = new Error('late delete failure'),
    ) => {
      await act(async () => {
        const request = ownerActions.deleteRequests[index];
        if (!request) throw new Error(`Missing delete request ${index}.`);
        if (outcome === 'resolve') request.resolve();
        else request.reject(error);
        await Promise.resolve();
      });
    };
    const waitForDeleteClosed = async () => {
      await dismissed('alertdialog');
      deleteDialogCloseCount += 1;
    };
    const waitForReportClosed = async () => {
      await dismissed('dialog');
      reportDialogCloseCount += 1;
    };
    const currentDeleteButton = () =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete content' });

    await expect(canvas.getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Report' })).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const menu = await settled(await screen.findByRole('menu'));
    await expect(within(menu).getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Pin Collection' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    await expect(within(menu).queryByRole('menuitem', { name: 'Report' })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Pin Collection' }));
    await expect(ownerActions.pin).toHaveBeenCalledTimes(1);
    await dismissed('menu');

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const copyMenu = await settled(await screen.findByRole('menu'));
    await userEvent.click(within(copyMenu).getByRole('menuitem', { name: 'Copy link' }));
    await expect(ownerActions.copy).toHaveBeenCalledTimes(1);
    await dismissed('menu');

    await userEvent.click(canvas.getByRole('button', { name: 'More actions' }));
    const editMenu = await settled(await screen.findByRole('menu'));
    await userEvent.click(within(editMenu).getByRole('menuitem', { name: 'Edit' }));
    await expect(ownerActions.edit).toHaveBeenCalledTimes(1);
    await dismissed('menu');

    let confirmation = await openDelete();
    await expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toBeVisible();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(1);
    await finishDelete(0, 'reject', new Error('The delete service is temporarily unavailable.'));
    await expect(await within(confirmation).findByRole('alert')).toHaveTextContent(
      'The delete service is temporarily unavailable.',
    );
    await expect(within(confirmation).getByRole('button', { name: 'Delete content' })).toBeEnabled();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(2);
    await finishDelete(1, 'resolve');
    await waitForDeleteClosed();
    await waitForFocus([canvas.getByRole('button', { name: 'More actions' })]);

    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(3);
    await act(async () => controls().setDeleteAvailable(false));
    await waitForDeleteClosed();
    await act(async () => controls().setDeleteAvailable(true));
    await expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await act(async () => controls().rerender((value) => value + 1));

    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(4);
    await act(async () => controls().rerender((value) => value + 1));
    await expect(currentDeleteButton()).toHaveAttribute('aria-busy', 'true');
    await finishDelete(2, 'resolve');
    await expect(currentDeleteButton()).toHaveAttribute('aria-busy', 'true');
    await expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await finishDelete(3, 'reject', new Error('The current delete retry failed.'));
    await expect(await within(confirmation).findByRole('alert')).toHaveTextContent('The current delete retry failed.');
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(5);
    await finishDelete(4, 'resolve');
    await waitForDeleteClosed();

    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(6);
    await act(async () => controls().setDeleteAvailable(false));
    await waitForDeleteClosed();
    await act(async () => controls().setDeleteAvailable(true));
    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(7);
    await finishDelete(5, 'reject', new Error('An obsolete delete failure.'));
    await expect(currentDeleteButton()).toHaveAttribute('aria-busy', 'true');
    await expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await finishDelete(6, 'resolve');
    await waitForDeleteClosed();

    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(8);
    await act(async () => controls().setActionsMounted(false));
    await waitForDeleteClosed();
    await act(async () => controls().setActionsMounted(true));
    confirmation = await openDelete();
    await startDelete(confirmation);
    await expect(ownerActions.delete).toHaveBeenCalledTimes(9);
    await finishDelete(7, 'resolve');
    await expect(currentDeleteButton()).toHaveAttribute('aria-busy', 'true');
    await finishDelete(8, 'resolve');
    await waitForDeleteClosed();

    await act(async () => controls().setOwner(false));
    const reportTrigger = canvas.getByRole('button', { name: 'More actions' });
    reportTrigger.focus();
    await userEvent.keyboard('{Enter}');
    const reportMenu = await settled(await screen.findByRole('menu'));
    await waitForFocus([reportMenu, ...within(reportMenu).getAllByRole('menuitem')]);
    await userEvent.keyboard('{End}');
    await highlighted(() => within(reportMenu).getAllByRole('menuitem').at(-1)!);
    await userEvent.keyboard('{Enter}');
    let dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(1);
    await expect(ownerActions.reportOpenChange).toHaveBeenLastCalledWith(true);
    await expect(within(dialog).getByRole('group', { name: 'Verification' })).toBeVisible();

    const illegal = within(dialog).getByRole('radio', { name: 'Illegal activity' });
    const details = within(dialog).getByRole('textbox', { name: 'Additional details' });
    const submit = within(dialog).getByRole('button', { name: 'Submit report' });
    await userEvent.click(illegal);
    await expect(details).toBeRequired();
    await userEvent.type(details, 'x'.repeat(45));
    await expect(details).toHaveValue('x'.repeat(40));
    await expect(within(dialog).getByRole('status', { name: 'Character count' })).toHaveTextContent(
      '40 of 40 characters',
    );
    await expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete verification' }));
    await expect(submit).toBeEnabled();

    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!valueSetter) throw new Error('The native textarea value setter is unavailable.');
    await act(async () => {
      valueSetter.call(details as HTMLTextAreaElement, 'y'.repeat(41));
      details.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'y' }));
    });
    await waitFor(() => expect(details).toHaveValue('y'.repeat(41)));
    await expect(submit).toBeDisabled();
    const form = details.closest('form');
    if (!form) throw new Error('The report form is not mounted.');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(ownerActions.report).toHaveBeenCalledTimes(0);

    await userEvent.clear(details);
    const reportDetails = 'The listing promotes a prohibited sale.';
    await userEvent.type(details, reportDetails);
    await expect(submit).toBeEnabled();
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(submit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(1);
    await expect(ownerActions.reportRequests[0]?.report).toEqual({ reason: 'illegal', details: reportDetails });
    await act(async () => controls().rerender((value) => value + 1));
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(details).toHaveValue(reportDetails);
    await act(async () => {
      ownerActions.reportRequests[0]!.result.reject(new Error('The moderation service is temporarily unavailable.'));
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The moderation service is temporarily unavailable.',
    );
    await expect(details).toHaveValue(reportDetails);
    await expect(illegal).toBeChecked();
    await userEvent.click(submit);
    await waitFor(() => expect(submit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(2);
    await expect(ownerActions.reportRequests[1]?.report).toEqual({ reason: 'illegal', details: reportDetails });
    await act(async () => {
      ownerActions.reportRequests[1]!.result.resolve();
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('status', { name: 'Thank you for your report.' })).toHaveTextContent(
      'Our moderation team will review it.',
    );
    const successfulReportAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(dialog).toBeInTheDocument();
    await waitForReportClosed();
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(2);
    const successfulReportDuration = performance.now() - successfulReportAt;
    await expect(successfulReportDuration).toBeGreaterThanOrEqual(800);
    await expect(successfulReportDuration).toBeLessThan(2500);
    await waitForFocus([reportTrigger]);

    await act(async () => controls().setParentReportOpen(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const staleReason = within(dialog).getByRole('radio', { name: 'Spam' });
    const staleDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    await userEvent.click(staleReason);
    await userEvent.type(staleDetails, 'obsolete success draft');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(ownerActions.report).toHaveBeenCalledTimes(3));
    await act(async () => controls().setParentReportOpen(false));
    await waitForReportClosed();
    await act(async () => controls().setParentReportOpen(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const currentReason = within(dialog).getByRole('radio', { name: 'Off topic' });
    const currentDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    const currentSubmit = within(dialog).getByRole('button', { name: 'Submit report' });
    await expect(currentDetails).toHaveValue('');
    await userEvent.click(currentReason);
    await userEvent.type(currentDetails, 'fresh draft survives obsolete success');
    await userEvent.click(currentSubmit);
    await waitFor(() => expect(currentSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(4);
    await act(async () => {
      ownerActions.reportRequests[2]!.result.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Submit report' })).toHaveAttribute('aria-busy', 'true'),
    );
    await expect(within(dialog).getByRole('textbox', { name: 'Additional details' })).toHaveValue(
      'fresh draft survives obsolete success',
    );
    await expect(within(dialog).getByRole('radio', { name: 'Off topic' })).toBeChecked();
    await expect(within(dialog).queryByRole('status', { name: 'Thank you for your report.' })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 950));
    await expect(dialog).toBeInTheDocument();
    await expect(currentSubmit).toHaveAttribute('aria-busy', 'true');
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(2);
    await act(async () => {
      ownerActions.reportRequests[3]!.result.reject(new Error('The current report attempt failed.'));
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent('The current report attempt failed.');
    await expect(currentDetails).toHaveValue('fresh draft survives obsolete success');
    await userEvent.click(currentSubmit);
    await waitFor(() => expect(currentSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(5);
    await act(async () => {
      ownerActions.reportRequests[4]!.result.resolve();
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('status', { name: 'Thank you for your report.' })).toBeVisible();
    await waitForReportClosed();
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(3);

    await act(async () => controls().setParentReportOpen(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const obsoleteFailureReason = within(dialog).getByRole('radio', { name: 'Spam' });
    const obsoleteFailureDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    await userEvent.click(obsoleteFailureReason);
    await userEvent.type(obsoleteFailureDetails, 'obsolete rejection draft');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(ownerActions.report).toHaveBeenCalledTimes(6));
    await act(async () => controls().setParentReportOpen(false));
    await waitForReportClosed();
    await act(async () => controls().setParentReportOpen(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const latestReason = within(dialog).getByRole('radio', { name: 'Other' });
    const latestDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    const latestSubmit = within(dialog).getByRole('button', { name: 'Submit report' });
    await userEvent.click(latestReason);
    await userEvent.type(latestDetails, 'current report remains pending');
    await userEvent.click(latestSubmit);
    await waitFor(() => expect(latestSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(7);
    await act(async () => {
      ownerActions.reportRequests[5]!.result.reject(new Error('Obsolete report rejection.'));
      await Promise.resolve();
    });
    await waitFor(() => expect(latestSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(latestDetails).toHaveValue('current report remains pending');
    await expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(3);
    await act(async () => {
      ownerActions.reportRequests[6]!.result.resolve();
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('status', { name: 'Thank you for your report.' })).toBeVisible();
    await waitForReportClosed();
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(4);

    await act(async () => controls().setParentReportOpen(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const unmountedReason = within(dialog).getByRole('radio', { name: 'Spam' });
    const unmountedDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    await userEvent.click(unmountedReason);
    await userEvent.type(unmountedDetails, 'request from unmounted dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(ownerActions.report).toHaveBeenCalledTimes(8));
    await act(async () => controls().setActionsMounted(false));
    await waitForReportClosed();
    await act(async () => controls().setActionsMounted(true));
    dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const mountedReason = within(dialog).getByRole('radio', { name: 'Off topic' });
    const mountedDetails = within(dialog).getByRole('textbox', { name: 'Additional details' });
    const mountedSubmit = within(dialog).getByRole('button', { name: 'Submit report' });
    await expect(mountedDetails).toHaveValue('');
    await userEvent.click(mountedReason);
    await userEvent.type(mountedDetails, 'new mounted dialog draft');
    await userEvent.click(mountedSubmit);
    await waitFor(() => expect(mountedSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(ownerActions.report).toHaveBeenCalledTimes(9);
    await act(async () => {
      ownerActions.reportRequests[7]!.result.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mountedSubmit).toHaveAttribute('aria-busy', 'true'));
    await expect(mountedDetails).toHaveValue('new mounted dialog draft');
    await expect(within(dialog).queryByRole('status', { name: 'Thank you for your report.' })).not.toBeInTheDocument();
    await act(async () => {
      ownerActions.reportRequests[8]!.result.resolve();
      await Promise.resolve();
    });
    await expect(await within(dialog).findByRole('status', { name: 'Thank you for your report.' })).toBeVisible();
    await waitForReportClosed();
    await expect(ownerActions.reportOpenChange).toHaveBeenCalledTimes(5);
    await expect(ownerActions.reportOpenChange.mock.calls.map(([open]) => open)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    await expect(deleteDialogCloseCount).toBe(7);
    await expect(reportDialogCloseCount).toBe(7);
  },
};
