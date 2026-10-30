import { useEffect, useState } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import { createTypes, type CreateResult } from './create-subject';
import { GameInitialFacts } from './game-profile-fields';
import type { StatementInput } from './statement-editor';
import {
  addonBase,
  addonInitialDraft,
  addonFields,
  addonType,
  type AddonRead,
  type AddonTransport,
} from './addon-profile';

type InitialFact = { key: string; statement: StatementInput };
/** Configures the existing game creation controls for the one admitted add-on Type. */
export function AddonProfileCreate({
  read,
  locale,
  session,
  transport,
  search,
  onCreated,
}: {
  read: Extract<AddonRead, { ok: true }>;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: AddonTransport;
  search: EntityPickerSearch;
  onCreated: (result: Extract<CreateResult, { ok: true }>) => void;
}) {
  const o = { locale: locale as never };
  const [release, setRelease] = useState(read.release);
  useEffect(() => setRelease(read.release), [read.release]);
  const [facts, setFacts] = useState<InitialFact[]>([]);
  return (
    <CreateSubjectForm
      locale={locale}
      session={session}
      transport={{
        definitions: async (refresh) => {
          const current = refresh ? await transport.load({ work: read.work?.subject.id }) : read;
          if (!current.ok) return { ok: false };
          if (refresh) setRelease(current.release);
          return { ok: true, types: createTypes(current.release, locale).filter((entry) => entry.id === addonType) };
        },
        submit: transport.create,
        read: transport.read,
      }}
      onNavigate={() => undefined}
      onCreated={onCreated}
      profile={{
        title: m.addon_title({}, o),
        scope: 'addon',
        type: addonType,
        href: `/${locale}/catalogue/addon${read.work ? `?work=${encodeURIComponent(read.work.subject.id)}` : ''}`,
        hideHeading: true,
        labelLanguage: (type) => pageText(release.types[type]?.labels, locale).lang,
        descriptionLanguage: (type) => pageText(release.types[type]?.descriptions, locale).lang,
        control: (pointer) => (pointer.startsWith('/statements') ? 'addon-initial-facts' : undefined),
        prepare: (initial) =>
          addonInitialDraft(
            release,
            initial,
            facts.map((row) => row.statement),
          ),
        fields: (_type, disabled) => (
          <div id="addon-initial-facts" className="space-y-5">
            {read.work &&
              !facts.some(
                (row) =>
                  row.statement.property.id === addonBase &&
                  row.statement.value.type === 'value' &&
                  row.statement.value.content === read.work!.subject.id,
              ) && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || !addonFields(release).includes(addonBase)}
                  onClick={() =>
                    setFacts((rows) => [
                      ...rows,
                      {
                        key: crypto.randomUUID(),
                        statement: {
                          property: { id: addonBase },
                          value: { type: 'value', content: read.work!.subject.id },
                          qualifiers: [],
                          references: [],
                          rank: 'normal',
                        },
                      },
                    ])
                  }
                >
                  {m.addon_use_base({}, o)}
                </Button>
              )}
            <GameInitialFacts
              type={addonType}
              release={release}
              locale={locale}
              search={search}
              statements={facts}
              disabled={disabled}
              change={setFacts}
            />
          </div>
        ),
      }}
    />
  );
}
