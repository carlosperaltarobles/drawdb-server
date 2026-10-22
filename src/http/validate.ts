import type { z } from 'zod';
import { AppError } from './app-error';

/** The parsed value, or an `invalid_input` AppError. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('invalid_input');
  return result.data;
}
