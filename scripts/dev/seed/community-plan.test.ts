import { describe, expect, test } from 'bun:test';
import { steps } from './cli.ts';
import { communityPeople, communityRealms, communityThreads } from './community-plan.ts';
import { extraWorks, fictionWorks, penNames, publicTexts } from './official-plan.ts';
import { people, works } from './plan.ts';
import { seedCoReaders } from './reading-lives-coreaders.ts';

const everyone = new Set([...people, ...communityPeople].map(person => person.id));
/** Works with a public text by the time the community step runs: discussions and adoptions need one. */
const publicTexted = new Set([...works.filter(work => work.excerpt).map(work => work.id), ...Object.keys(publicTexts),
  ...fictionWorks.map(work => work.id), ...extraWorks.map(work => work.id)]);

describe('Community people', () => {
  test('sign up with their own unique handle, email and id', () => {
    const all = [...people, ...communityPeople];
    for (const key of ['id', 'handle', 'email'] as const) {
      expect(new Set(all.map(person => person[key])).size).toBe(all.length);
    }
    expect(communityPeople.some(person => penNames.some(pen => pen.id === person.id))).toBe(false);
  });
});

describe('Community Realms', () => {
  test('three or four, each founded, moderated and joined by seed people', () => {
    expect(communityRealms.length).toBeGreaterThanOrEqual(3);
    expect(communityRealms.length).toBeLessThanOrEqual(4);
    for (const realm of communityRealms) {
      expect(realm.moderators).toContain(realm.owner);
      expect(realm.members).toContain(realm.owner);
      for (const id of realm.moderators) expect(realm.members).toContain(id);
      for (const id of realm.members) expect(everyone.has(id)).toBe(true);
      expect(new Set(realm.members).size).toBe(realm.members.length);
      expect(realm.rules.length).toBeGreaterThan(0);
      for (const id of realm.adopt) expect(publicTexted.has(id)).toBe(true);
    }
    // Not every Realm has the same six members any more.
    expect(new Set(communityRealms.map(realm => realm.members.length)).size).toBeGreaterThan(1);
  });

  test('each has five to ten discussions by its members about Works it adopted', () => {
    expect(new Set(communityThreads.map(thread => thread.id)).size).toBe(communityThreads.length);
    for (const realm of communityRealms) {
      const threads = communityThreads.filter(thread => thread.realm === realm.id);
      expect(threads.length).toBeGreaterThanOrEqual(5);
      expect(threads.length).toBeLessThanOrEqual(10);
      for (const thread of threads) {
        expect(realm.adopt).toContain(thread.work);
        const authors = [thread.author, ...thread.replies.map(reply => reply.author)];
        for (const author of authors) expect(realm.members).toContain(author);
        expect(thread.replies.length).toBeGreaterThan(0);
        // Voters are the Realm's other members.
        expect(thread.votes + (thread.down ?? 0)).toBeLessThanOrEqual(realm.members.length - 1);
        for (const reply of thread.replies) expect(reply.votes ?? 0).toBeLessThanOrEqual(realm.members.length - 1);
        // The first line is the title; Main caps a reply at 8192 characters.
        expect(thread.body.split('\n')[0]!.length).toBeLessThanOrEqual(120);
        for (const body of [thread.body, ...thread.replies.map(reply => reply.body)]) {
          expect(body.length).toBeLessThanOrEqual(8192);
          expect(body.trim()).toBe(body);
        }
      }
    }
  });

  test('speak their languages and cover questions, spoilers and a mod compatibility fix', () => {
    const languages = (realm: string) => new Set(communityThreads.filter(thread => thread.realm === realm)
      .flatMap(thread => [thread.language, ...thread.replies.map(reply => reply.language ?? thread.language)]));
    expect([...languages('web-novel-club')]).toEqual(expect.arrayContaining(['zh-Hans', 'ja']));
    expect([...languages('prompt-craft')]).toEqual(expect.arrayContaining(['en', 'ja']));
    expect(languages('classics-circle').has('en')).toBe(true);
    const titles = communityThreads.map(thread => thread.body.split('\n')[0]!);
    expect(titles.some(title => title.includes('【剧透】'))).toBe(true);
    expect(titles.some(title => title.startsWith('Spoilers'))).toBe(true);
    expect(titles.some(title => /[?？]$/.test(title))).toBe(true);
    expect(communityThreads.some(thread => thread.realm === 'mc-modding' && thread.work === 'lumen-fabric'
      && /Iris/.test(thread.body))).toBe(true);
  });
});

describe('Seed order', () => {
  test('co-readers are built after every shelf, rating and review, right before the read checks', () => {
    expect(steps.indexOf(seedCoReaders)).toBe(steps.length - 3);
  });
});
