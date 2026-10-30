import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import releaseRecording from '../kernel/recorded/definitions-release.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { Refinement, type RefinementData } from '../search/refinement/refinement';
import { refinementProperties, type RefinementConditions } from '../search/refinement/model';
import type { FacetState } from '../search/refinement/request';
import { PageStory, PatternStory, pageReady } from './page';

const properties = refinementProperties(releaseRecording.release, 'schema:Book');
const types = Object.entries(releaseRecording.release.types)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .map(([value, definition]) => ({ value, labels: definition.labels }));
// Typed presentation fixtures for the adopted wire; neither native recordings nor visual approval.
const initial: FacetState = {
  status: 'ready',
  page: {
    facets: [{ property: 'type', values: types.slice(0, 10), next: 'opaque-story-type-next' }],
    as_of: '2026-10-31T00:00:00Z',
  },
};
const meta = {
  title: 'Patterns/Discovery/Search Refinement',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The live Search refinement region. Review at 390 and 1280 with locale and theme globals. Continuation fixtures describe the adopted wire; native and visual review remain pending.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({
  state = initial,
  conditions = { facetValues: {} },
}: {
  state?: FacetState;
  conditions?: RefinementConditions;
}) {
  const data: RefinementData = { key: 'story-release-public-anonymous', properties, initial: state };
  return (
    <PatternStory>
      <div className="mx-auto max-w-sm">
        <Refinement
          data={data}
          conditions={conditions}
          query="The"
          locale={getLocale()}
          load={async (facets) => ({
            status: 'ready',
            page: {
              facets: facets.map(({ property, cursor }) => ({
                property,
                values: property === 'type' ? (cursor ? types.slice(10, 20) : types.slice(0, 10)) : [],
                next: property === 'type' && !cursor ? 'opaque-story-type-next' : null,
              })),
              as_of: '2026-10-31T00:00:00Z',
            },
          })}
        />
      </div>
    </PatternStory>
  );
}

export const Values: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = canvas.getAllByRole('checkbox').length;
    await userEvent.click(canvas.getByRole('button', { name: m.refinement_more_values() }));
    await expect(canvas.getAllByRole('checkbox').length).toBeGreaterThan(before);
    await expect(canvas.queryByRole('button', { name: m.refinement_more_values() })).toBeNull();
  },
};
export const Selected: Story = {
  render: () => (
    <Example
      conditions={{
        facetValues: { type: [types[0]!.value] },
        ranges: { 'schema:datePublished': { gte: 1900, lte: 2026 } },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('checkbox')[0]).toBeChecked();
    await expect(canvas.getByRole('link', { name: m.refinement_clear() })).toHaveAttribute(
      'href',
      `/${getLocale()}/search?q=The`,
    );
  },
};
export const Range: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.refinement_property() }), 'schema:wordCount');
    await expect(canvas.getByRole('combobox', { name: m.refinement_unit() })).toHaveValue('1');
    const minimum = canvas.getAllByRole('spinbutton', { name: m.refinement_lower() })[0]!;
    await userEvent.type(minimum, '1000001');
    await expect(minimum).toHaveValue(1000001);
  },
};
export const Unavailable: Story = {
  render: () => <Example state={{ status: 'unavailable', code: 'invalid_facet_response' }} />,
};
export const Refused: Story = {
  render: () => <Example state={{ status: 'refused', httpStatus: 403, code: 'platform_closed' }} />,
};
export const Preparing: Story = {
  render: () => <Example state={{ status: 'preparing', httpStatus: 503, code: 'index_not_ready' }} />,
};
export const Restart: Story = {
  render: () => (
    <Example
      state={{ status: 'restart', httpStatus: 409, code: 'search_restart_required' }}
      conditions={{ facetValues: { type: ['schema:Book'] } }}
    />
  ),
};
export const PageFilters: Story = {
  render: () => <PageStory visitor="Signed Out" path="/search?q=The&type=schema%3ABook" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const controls = canvas.getAllByRole('button', { name: new RegExp(m.search_filters()) });
    const visible = controls.find((control) => control.getClientRects().length > 0);
    if (visible) await userEvent.click(visible);
  },
};
