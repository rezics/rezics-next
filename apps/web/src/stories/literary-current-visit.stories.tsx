import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiteraryCurrentVisitAdmission } from '../features/catalogue/literary-current-visit-view';
import { getLocale } from '../paraglide/runtime';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000941';
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000942';
const meta = {
  title: 'Pages/Catalogue/Literary current visit',
  component: LiteraryCurrentVisitAdmission,
  args: { input: { kind: 'direct' }, locale: 'en', globalHref: '/en/catalogue/literary', children: null },
  render: () => (
    <LiteraryCurrentVisitAdmission
      locale={getLocale()}
      input={{
        kind: 'visit',
        visit: {
          context: '0192f3a0-6c1e-7b2a-9d4e-000000000943',
          realm,
          type: 'schema:Book',
          source: `/${getLocale()}/subjects/${id}/book?realm=${realm}`,
        },
      }}
      globalHref={`/${getLocale()}/subjects/${id}/book/literary`}
    >
      {null}
    </LiteraryCurrentVisitAdmission>
  ),
} satisfies Meta<typeof LiteraryCurrentVisitAdmission>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NonGlobalCorrection: Story = {};
