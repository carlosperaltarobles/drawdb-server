import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './passwords';

const email = z.string().trim().pipe(z.email().max(254));
const password = z.string().min(MIN_PASSWORD_LENGTH);
const token = z.string().min(1);

export const registerSchema = z.object({
  email,
  name: z.string().trim().min(1).max(80),
  password,
});
export const emailSchema = z.object({ email });
export const verifySchema = z.object({ token, password: z.string().min(1) });
export const loginSchema = z.object({ email, password: z.string().min(1) });
export const resetSchema = z.object({ token, password });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});
