const STATUS = {
  invalid_input: 400,
  registration_not_allowed: 400,
  cannot_change_superadmin: 400,
  last_admin: 400,
  user_not_verified: 400,
  forbidden: 403,
  not_found: 404,
  snapshot_limit: 409,
} as const;

export type AppErrorCode = keyof typeof STATUS;

/** An expected failure the error handler answers as `{ error: code }` with its status. */
export class AppError extends Error {
  readonly status: number;
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode);
  constructor(status: number, code: AppErrorCode);
  constructor(statusOrCode: number | AppErrorCode, maybeCode?: AppErrorCode) {
    const code = typeof statusOrCode === 'number' ? maybeCode! : statusOrCode;
    super(code);
    this.code = code;
    this.status = typeof statusOrCode === 'number' ? statusOrCode : STATUS[code];
  }
}
