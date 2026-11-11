import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CreateZone } from '../../../features/zones/manage/create';
import { createOwnedZone } from '../../../features/zones/manage/request';
import { zoneEditorFixture } from '../../../features/zones/editor/fixture';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { pickText } from '@rezics/composition';
import { starterChoices } from '../../../features/zones/manage/starters';
import { selectSharedOption } from '../../shared-select-interaction';

function starterLabel(id: string) {
  return pickText(starterChoices.find((choice) => choice.id === id)!.labels, getLocale()).text;
}

function CreateNames() {
  const [fixture] = useState(zoneEditorFixture);
  return (
    <div className="p-4">
      <CreateZone
        locale={getLocale()}
        session="signed-in"
        onCreate={(command) =>
          createOwnedZone(
            fixture.client,
            new Request('https://site.fixture.test/create', {
              method: 'POST',
              headers: { authorization: fixture.authorization },
            }),
            {},
            command,
          )
        }
        onNavigate={() => {
          /* Keep the saved result in the story. */
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Zones/Name validation',
  id: 'patterns-zones-name-validation',
  render: () => <CreateNames />,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Synthetic API naming and correction journey in every interface locale. Native and browser execution is deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CorrectOrRemoveTranslation: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await selectSharedOption(view.getByLabelText(m.zones_create_starter()), starterLabel('book'));
    await selectSharedOption(
      view.getByLabelText(m.zone_name_language()),
      new Intl.DisplayNames([getLocale()], { type: 'language' }).of('ja')!,
    );
    await expect(view.getAllByRole('textbox')).toHaveLength(1);
    const primary = view.getByLabelText(m.zone_name_primary());
    await expect(primary).toHaveValue('');
    await userEvent.click(view.getByRole('button', { name: m.zones_create_submit() }));
    await expect(primary).toHaveAttribute('aria-invalid', 'true');
    await expect(primary).toHaveAccessibleDescription(/.+/);
    await userEvent.type(primary, '私の本棚');
    await expect(primary).toHaveAttribute('aria-invalid', 'false');

    await userEvent.click(view.getByText(m.zone_name_translations()));
    await selectSharedOption(
      view.getByLabelText(m.zone_name_add()),
      new Intl.DisplayNames([getLocale()], { type: 'language' }).of('de')!,
    );
    await userEvent.click(view.getByText(m.zone_name_translations()));
    await userEvent.click(view.getByRole('button', { name: m.zones_create_submit() }));
    const language = new Intl.DisplayNames([getLocale()], { type: 'language' }).of('de')!;
    const translation = view.getByLabelText(language);
    await expect(translation).toBeVisible();
    await expect(translation).toHaveAttribute('aria-invalid', 'true');
    await expect(translation).toHaveAccessibleDescription(new RegExp(m.zone_name_invalid({ language })));
    await userEvent.click(view.getByRole('button', { name: m.zone_name_remove({ language }) }));
    await userEvent.click(view.getByRole('button', { name: m.zones_create_submit() }));
    await expect(await view.findByText(m.zones_create_saved())).toBeVisible();
  },
};
