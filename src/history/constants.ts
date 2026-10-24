export const NAMED_LIMIT = 100;
export const NAME_MAX = 80;
export const BULK_MIN_DELETES = 2;
export const BULK_DELETES = 5;
export const BULK_TABLE_RATIO = 0.3;
export const BULK_COOLDOWN_MS = 60_000;
export const PRUNE_INTERVAL_MS = 6 * 3600_000;
export const KEEP_ALL_MS = 48 * 3600_000;
export const DAILY_UNTIL_DAYS = 30;
export const WEEKLY_UNTIL_DAYS = 183;
export const SAFETY_KEEP_DAYS = 30;
export const HISTORY_PAGE = 50;
/** The first prune after a deploy can delete many large rows; Prisma's default is 5 s. */
export const PRUNE_TX_TIMEOUT_MS = 10 * 60_000;
