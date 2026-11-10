import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { pickZoneName } from '@rezics/composition';
import { CreateZone } from '../../../features/zones/manage/create';
import { createOwnedZone } from '../../../features/zones/manage/request';
import { zoneEditorFixture } from '../../../features/zones/editor/fixture';
import { ZoneEditorSession } from '../../../features/zones/editor/model';
import { ZoneConfigurationEditor } from '../../../features/zones/editor/view';
import { m } from '../../../paraglide/messages.js';

function NamingJourney() {
  const [fixture] = useState(zoneEditorFixture);
  const [session, setSession] = useState<ZoneEditorSession>();
  const [locale, setLocale] = useState('en');
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <Button onClick={() => setLocale((value) => (value === 'en' ? 'fr' : 'en'))}>Switch interface language</Button>
      {session ? (
        <ZoneConfigurationEditor session={session} locale={locale} />
      ) : (
        <CreateZone
          locale={locale}
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
            void fixture.transport
              .load()
              .then((loaded) => setSession(new ZoneEditorSession(fixture.transport, loaded)));
          }}
        />
      )}
    </div>
  );
}

const meta = {
  title: 'Zones/Authored names',
  id: 'patterns-zones-authored-names',
  render: () => <NamingJourney />,
  globals: { locale: 'en' },
  parameters: {
    docs: {
      description: {
        component:
          'One synthetic fixture journey through the real create and configuration UI. Native and browser execution remain deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CreateReadRenameRead: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    // Missing or withheld primary text must not turn an unrelated translation into the primary.
    const withheld = { primaryLanguage: 'ja' as const, labels: { de: 'Mein Regal' } };
    await expect(pickZoneName(withheld, 'fr')).toEqual({ text: '' });
    await expect(pickZoneName(withheld, 'de')).toEqual({ text: 'Mein Regal', lang: 'de' });
    await userEvent.selectOptions(view.getByLabelText(m.zones_create_starter()), 'book');
    await expect(view.getByLabelText(m.zone_name_primary())).toHaveValue('');
    await userEvent.selectOptions(view.getByLabelText(m.zone_name_language()), 'ja');
    await userEvent.type(view.getByLabelText(m.zone_name_primary()), '私の本棚');
    await userEvent.selectOptions(view.getByLabelText(m.zone_name_language()), 'en');
    await expect(view.getByLabelText(m.zone_name_primary())).toHaveValue('');
    await userEvent.selectOptions(view.getByLabelText(m.zone_name_language()), 'ja');
    await expect(view.getByLabelText(m.zone_name_primary())).toHaveValue('私の本棚');
    await userEvent.click(view.getByRole('button', { name: 'Switch interface language' }));
    await expect(view.getByLabelText(m.zone_name_primary({}, { locale: 'fr' }))).toHaveValue('私の本棚');
    await userEvent.click(view.getByRole('button', { name: 'Switch interface language' }));
    await userEvent.click(view.getByRole('button', { name: m.zones_create_submit() }));
    const primary = await view.findByLabelText(m.zone_name_primary());
    await expect(primary).toHaveValue('私の本棚');
    await userEvent.clear(primary);
    await userEvent.type(primary, '新しい本棚');
    await userEvent.click(view.getByText(m.zone_name_translations()));
    await userEvent.selectOptions(view.getByLabelText(m.zone_name_add()), 'de');
    await userEvent.type(view.getByLabelText('German'), 'Mein Regal');
    await userEvent.click(view.getByRole('button', { name: m.zone_editor_save() }));
    await view.findByText(m.zone_editor_saved());
    await userEvent.click(view.getByRole('button', { name: m.zone_name_remove({ language: 'German' }) }));
    await userEvent.click(view.getByRole('button', { name: m.zone_editor_save() }));
    await view.findByText(m.zone_editor_saved());
    await userEvent.click(view.getByRole('button', { name: m.zone_editor_preview() }));
    await view.findAllByText('新しい本棚');
    await expect(view.queryByLabelText('German')).not.toBeInTheDocument();
    await expect(
      view.queryByRole('button', { name: m.zone_name_remove({ language: 'Japanese' }) }),
    ).not.toBeInTheDocument();
  },
};
