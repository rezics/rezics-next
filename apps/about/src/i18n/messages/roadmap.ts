import type { Horizon, Milestone } from '../../features.ts';
import { defineEnglishCopy } from '../define.ts';

export interface RoadmapCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string };
  availableTitle: string;
  availableLede: string;
  /** The three columns, headed by what they mean. */
  horizons: Record<Horizon, { title: string; body: string }>;
  /** GOAL.md's milestones as stages a reader can follow, in order. */
  milestones: Record<Milestone, { name: string; body: string }>;
  /** Says what order and missing dates mean. */
  note: string;
  cta: { title: string; body: string };
}

export const roadmap = defineEnglishCopy<RoadmapCopy>({
  meta: {
    title: 'The REZICS roadmap: what is being built now, next and later',
    description:
      'Five stages from foundations to launch. Every capability REZICS describes sits in one of them, so you can see what is being built now and what follows.',
  },
  hero: {
    title: 'Five stages to launch. The first is underway.',
    lede: 'Everything this site describes sits in one of five stages, built in order. Foundations come first because every scenario stands on them; registration opens when the fifth is done.',
  },
  availableTitle: 'Available today',
  availableLede: 'What already works for everyone this site reaches.',
  horizons: {
    now: {
      title: 'In development',
      body: 'The stage being built now.',
    },
    next: {
      title: 'Up next',
      body: 'The stages that follow directly, on the foundations being laid now.',
    },
    later: {
      title: 'Later',
      body: 'The stages after that, which bring knowledge, agents, publishing and launch.',
    },
  },
  milestones: {
    M4: {
      name: 'Foundations',
      body: 'Editions, languages and identities that mean exactly what they say; one account model for people, apps and agents; edits that never lose what you wrote.',
    },
    M5: {
      name: 'Shared capabilities and safety',
      body: 'Complete lists without hidden limits, operations that survive a retry, exports that keep everything, reporting and appeals, and the rules every page is served by.',
    },
    M6: {
      name: 'The four first scenarios',
      body: 'Series tracking led by light novels, the portable library, serial fiction and visual novels by release, with the Light Novels and ACGN Zones over them.',
    },
    M7: {
      name: 'Knowledge, agents and publishing',
      body: 'Reviews and corrections, Realms and their wikis, worldbuilding, the agent protocol with its first agents, developer onboarding and the first books and games for sale.',
    },
    M8: {
      name: 'Launch',
      body: 'Production checks, recovery drills, safety readiness and accessibility on real devices. Then registration opens.',
    },
  },
  note: 'There are no dates on purpose. A stage is finished when its checks pass, and a capability can move between stages as we learn.',
  cta: {
    title: 'Hear the day registration opens.',
    body: 'Leave your email and we will write once, when registration opens. Nothing else.',
  },
});
