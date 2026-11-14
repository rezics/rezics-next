import type { RegistrationPage, RegistrationPageRequirements } from '../../registration-page';

export const requirements: RegistrationPageRequirements = {
  handle: { minLength: 3, maxLength: 64 },
  email: { maxLength: 254 },
  password: { minLength: 8, maxLength: 128 },
  verification: { provider: 'turnstile', required: true },
};

export const registrationPage: RegistrationPage = {
  kind: 'registration',
  viewer: null,
  requirements,
  verification: { configured: true },
  actions: { register: true, continue: false },
  siteKey: 'story-presentation-only',
  scriptUrl: 'https://verification.example.test/story-only.js',
};
