import { config as dotenvConfig } from 'dotenv';
import { parseAiConfig, type AiConfig } from '../ai/config';

const dotenvLoaded = dotenvConfig();
if (dotenvLoaded.parsed) {
  for (const [key, value] of Object.entries(dotenvLoaded.parsed)) {
    if (value && (!process.env[key] || !process.env[key]!.trim())) {
      process.env[key] = value;
    }
  }
}

const env = process.env;
const appUrl = env.APP_URL || 'http://localhost:5173';

export const config = {
  dev: env.NODE_ENV === 'dev',
  port: Number(env.PORT) || 5000,
  appUrl,
  cookieSecure: appUrl.startsWith('https://'),
  allowedDomains: (env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  admin: {
    email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: env.ADMIN_PASSWORD || '',
  },
  mail: {
    host: env.MAIL_HOST || '',
    port: Number(env.MAIL_PORT) || 465,
    secure: env.MAIL_SECURE ? env.MAIL_SECURE === 'true' : true,
    username: env.MAIL_USERNAME || '',
    password: env.MAIL_PASSWORD || '',
    from: env.MAIL_FROM || env.MAIL_USERNAME || '',
  },
  databaseUrl: env.DATABASE_URL || '',
  githubToken: env.GITHUB_TOKEN || undefined,
  rateLimit: { enabled: env.NODE_ENV !== 'test' },
  ai: parseAiConfig(env),
};

/** The settings the HTTP app needs; injected through AppDeps so tests can override them. */
export type AppConfig = Pick<
  typeof config,
  'appUrl' | 'cookieSecure' | 'allowedDomains' | 'rateLimit' | 'githubToken'
> & {
  ai?: AiConfig;
};

