import { Algorithm, hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: Algorithm.Argon2id });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against the user's hash or, when there is no user, against a throwaway hash,
 * so both cases take about the same time and the response does not reveal which it was.
 */
export async function verifyPasswordOrDummy(
  passwordHash: string | undefined,
  password: string,
): Promise<boolean> {
  if (passwordHash) return verifyPassword(passwordHash, password);
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}
