export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the part after the last `@` equals one of the allowed domains. */
export function isAllowedDomain(email: string, allowed: string[]): boolean {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at < 1) return false;
  return allowed.includes(normalized.slice(at + 1));
}
