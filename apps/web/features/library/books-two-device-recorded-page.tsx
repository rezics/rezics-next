'use client';

import { useEffect, useState } from 'react';
import { materializeData } from 'native-i18n';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { mainLibraryApi } from './api.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { deviceOwner, deviceYear, twoDeviceReplay, twoDeviceState, type DevicePhase } from './books-two-device-recorded-page.ts';
import { LibraryPage } from './library-page.tsx';
import { messages } from './messages.ts';

/** The production Library page with a recorded client supplied at its reader boundary. */
export function BooksTwoDeviceRecorded({ persona, phase = 'winning', loading = false }: {
  persona: AnswerPersona; phase?: DevicePhase; loading?: boolean;
}) {
  const [visit, setVisit] = useState<{
    persona: AnswerPersona; phase: DevicePhase; loading: boolean;
    page: Awaited<ReturnType<typeof loadBooksLibrary>>; replay: ReturnType<typeof twoDeviceReplay>;
  } | null>(null);
  useEffect(() => {
    const replay = twoDeviceReplay(persona, phase, loading);
    let active = true;
    void loadBooksLibrary(replay.reader, { state: twoDeviceState, locale: 'en', year: deviceYear(phase), first: false })
      .then(page => { if (active) setVisit({ persona, phase, loading, page, replay }); });
    return () => { active = false; replay.dispose(); };
  }, [persona, phase, loading]);
  if (!visit || visit.persona !== persona || visit.phase !== phase || visit.loading !== loading)
    return <p role="status">{materializeData(messages, { locale: 'en' }).loading}</p>;
  const { replay, page } = visit;
  const subject = deviceOwner();
  return <LibraryPage key={`${persona}/${phase}/${loading}`} state={twoDeviceState} {...page} now={0}
    locale="en" messages={messages} api={mainLibraryApi(subject, () => replay.main)}
    readerActions={createReaderStore({ actingSubject: subject, main: () => replay.main,
      seed: page.view.ok ? page.view.data.seed : {} })} />;
}
