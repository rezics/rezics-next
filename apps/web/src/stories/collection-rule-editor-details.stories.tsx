import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionRuleEditor } from '../library/collection-rule-editor';
import type { RuleChoices, RulePage } from '../library/collection-rule-read';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Patterns/Library/Collection rule details',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Supplied-data editor examples only. Save deliberately returns an unconfirmed outcome; reload and label search return supplied data. No live API, native, visual or integration proof is claimed.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Ready = Extract<RulePage, { state: 'ready' }>;
const choices: RuleChoices = {
  release: {
    state: 'ready',
    metadata: { types: {}, properties: {} },
    profiles: [
      {
        id: 'profile:reading',
        entryStateSet: {
          id: 'state-set:reading:v2',
          states: [
            {
              id: 'state:reading',
              labels: {
                en: 'Reading',
                de: 'Wird gelesen',
                es: 'Leyendo',
                fr: 'En lecture',
                ja: '読書中',
                ko: '읽는 중',
                'zh-Hans': '在读',
                'zh-Hant': '閱讀中',
              },
            },
            {
              id: 'state:finished',
              labels: {
                en: 'Finished',
                de: 'Abgeschlossen',
                es: 'Terminado',
                fr: 'Terminé',
                ja: '読了',
                ko: '완료',
                'zh-Hans': '已读',
                'zh-Hant': '已讀',
              },
            },
          ],
        },
      },
    ],
  },
  labels: { state: 'ready', values: [{ id: 'label:weekend', name: 'Weekend reading' }], next: null },
};
const available: Ready = {
  state: 'ready',
  viewerId: 'supplied-viewer',
  id: 'supplied-rule',
  title: 'Reading collection',
  intent: '10000000-0000-4000-8000-000000000001',
  choices,
  rule: {
    filter: {
      and: [
        {
          owner: { state: { profileId: 'profile:reading', stateSetId: 'state-set:reading:v2', in: ['state:reading'] } },
        },
        { owner: { label: { id: 'label:weekend' } } },
      ],
    },
    sort: 'id',
    revision: 7,
    collectionRevision: 9,
    releaseDigest: 'sha256:supplied-immutable-definition-release',
    sourceGeneration: '12345678901234567890',
  },
};

function SuppliedEditor({ page = available, narrow = false }: { page?: RulePage; narrow?: boolean }) {
  return (
    <div className={narrow ? 'w-full max-w-sm p-4' : 'w-full p-4 md:p-6'}>
      <CollectionRuleEditor
        page={page}
        viewerId="supplied-viewer"
        collectionId={page.state === 'new' ? null : 'supplied-rule'}
        admitted={['collection.create', 'collection_rule.get', 'collection_rule.update', 'library_label.list']}
        csrfToken="supplied-csrf"
        save={async () => ({ ok: false, reason: 'unavailable' })}
        reload={async () => page}
        labels={async () => ({
          viewerId: 'supplied-viewer',
          choices: page.state === 'ready' || page.state === 'new' ? page.choices : choices,
        })}
      />
    </div>
  );
}

export const Available: Story = {
  render: () => <SuppliedEditor />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText(m.library_rule_label())).toHaveValue('label:weekend');
    const release = canvas.getByText(available.rule.releaseDigest);
    await expect(release).not.toBeVisible();
    await userEvent.click(canvas.getByText(`${m.catalogue_technical_details()} · ${m.library_rule_details()}`));
    await expect(release).toBeVisible();
    await expect(canvas.getByLabelText(m.library_rule_profile())).toHaveValue('profile:reading');
  },
};

const longId = `profile:${'long-reference-'.repeat(7)}`;
const longText: Ready = {
  ...available,
  choices: {
    ...choices,
    release: { ...choices.release, profiles: [{ ...choices.release.profiles[0]!, id: longId }] },
    labels: {
      state: 'ready',
      values: [
        {
          id: 'label:weekend',
          name: 'Weekend reading — books to revisit with friends, notes to compare, and unfinished reading for the next long holiday 週末の読書 閱讀清單',
        },
      ],
      next: null,
    },
  },
  rule: {
    ...available.rule,
    releaseDigest: `sha256:${'abcdef0123456789'.repeat(4)}`,
    filter: {
      and: [
        { owner: { state: { profileId: longId, stateSetId: 'state-set:reading:v2', in: ['state:reading'] } } },
        { owner: { label: { id: 'label:weekend' } } },
      ],
    },
  },
};
export const NarrowLongText: Story = { render: () => <SuppliedEditor page={longText} narrow /> };

const mismatched: Ready = {
  ...available,
  rule: {
    ...available.rule,
    filter: {
      owner: {
        state: {
          profileId: 'profile:reading',
          stateSetId: 'state-set:reading:v1',
          in: ['state:reading', 'state:retired'],
        },
      },
    },
  },
};
export const RetainedStateSet: Story = {
  render: () => <SuppliedEditor page={mismatched} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_rule_state_set_unavailable())).toBeVisible();
    await expect(canvas.getByLabelText(m.library_rule_state())).toHaveValue(['state:reading', 'state:retired']);
    await userEvent.click(canvas.getByText(`${m.catalogue_technical_details()} · ${m.library_rule_state()}`));
    await expect(canvas.getByText('state-set:reading:v1')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: `${m.library_subject_clear()} · ${m.library_rule_state()}` }),
    );
    await expect(canvas.getByLabelText(m.library_rule_state())).toHaveValue([]);
  },
};

const unavailable: Ready = {
  ...available,
  choices: {
    release: { state: 'unavailable', profiles: [] },
    labels: { state: 'unavailable', values: [], next: null },
  },
};
export const UnavailableChoices: Story = {
  render: () => <SuppliedEditor page={unavailable} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.condition_metadata_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.library_rule_labels_unavailable())).toBeVisible();
    await expect(canvas.getByLabelText(m.library_rule_label())).toHaveValue('label:weekend');
    await userEvent.click(canvas.getByText(`${m.catalogue_technical_details()} · ${m.library_rule_label()}`));
    await expect(canvas.getByText('label:weekend')).toBeVisible();
  },
};
export const UnconfirmedSave: Story = {
  render: () => <SuppliedEditor page={mismatched} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_save() }));
    await expect(await canvas.findByText(m.library_rule_uncertain())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_reload() }));
    await expect(canvas.getByLabelText(m.library_rule_state())).toBeDisabled();
    await expect(canvas.getByLabelText(m.library_rule_state())).toHaveValue(['state:reading', 'state:retired']);
    await expect(canvas.queryByText(m.library_rule_saved())).toBeNull();
  },
};
export const NewPrivateDraft: Story = {
  render: () => (
    <SuppliedEditor page={{ state: 'new', viewerId: 'supplied-viewer', choices, intent: available.intent }} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText(m.library_collection_title())).toHaveAccessibleDescription(
      m.library_rule_title_limit(),
    );
    await expect(canvas.getByText(m.library_rule_private())).toBeVisible();
    await expect(canvas.queryByText(available.rule.releaseDigest)).toBeNull();
  },
};
