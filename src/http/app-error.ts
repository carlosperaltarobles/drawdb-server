const STATUS = {
  invalid_input: 400,
  registration_not_allowed: 400,
  cannot_change_superadmin: 400,
  last_admin: 400,
  not_found: 404,
} as const;

export type AppErrorCode = keyof typeof STATUS;

/** An expected failure the error handler answers as `{ error: code }` with its status. */
export class AppError extends Error {
  readonly status: number;

  constructor(readonly code: AppErrorCode) {
    super(code);
    this.status = STATUS[code];
  }
}
