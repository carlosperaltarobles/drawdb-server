import { z } from 'zod';
import { COLLS, SUBS, type Op } from './ops';

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const maxJsonDepth = 64;
const id = z.union([z.string(), z.number()]);
const coll = z.enum(COLLS);
const nested = { coll: z.literal('tables'), id, sub: z.enum(SUBS.tables) };
const item = z.object({ id }).catchall(z.unknown());
// Mantener etiquetas sincronizadas con FE/src/data/constants.js (DB).
const database = z.enum([
  'mysql',
  'postgresql',
  'transactsql',
  'sqlite',
  'mariadb',
  'oraclesql',
  'generic',
]);
const subitems = z
  .array(item)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length);
const tableItem = z
  .object({
    id,
    fields: subitems.optional(),
    indices: subitems.optional(),
    uniqueConstraints: subitems.optional(),
  })
  .catchall(z.unknown());
const patch = {
  patch: z.record(z.string(), z.unknown()),
  unset: z.array(z.string().refine((key) => !forbiddenKeys.has(key))).optional(),
};
const index = z.number().int().nonnegative();
const operations = z
  .array(
    z.discriminatedUnion('t', [
      z
        .strictObject({
          t: z.literal('set'),
          key: z.enum(['database', 'sqlHeader']),
          value: z.string(),
        })
        .refine((op) => op.key !== 'database' || database.safeParse(op.value).success),
      z
        .strictObject({ t: z.literal('add'), coll, item, index })
        .refine((op) => op.coll !== 'tables' || tableItem.safeParse(op.item).success),
      z.strictObject({ t: z.literal('del'), coll, id }),
      z.strictObject({ t: z.literal('patch'), coll, id, ...patch }),
      z.strictObject({ t: z.literal('order'), coll, ids: z.array(id) }),
      z.strictObject({ t: z.literal('sadd'), ...nested, item, index }),
      z.strictObject({ t: z.literal('sdel'), ...nested, sid: id }),
      z.strictObject({ t: z.literal('spatch'), ...nested, sid: id, ...patch }),
      z.strictObject({ t: z.literal('sorder'), ...nested, ids: z.array(id) }),
    ]),
  )
  .max(5000);

/** Check before Zod clones records: prototype keys must never be silently removed. */
function isSafeJson(input: unknown): boolean {
  const ancestors = new WeakSet<object>();
  // Count edges from the batch root so every value reaching recursive consumers is bounded.
  const stack: { value: unknown; depth: number; leaving?: boolean }[] = [
    { value: input, depth: 0 },
  ];
  while (stack.length) {
    const { value, depth, leaving } = stack.pop()!;
    if (depth > maxJsonDepth) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object') return false;
    if (leaving) {
      ancestors.delete(value);
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== null && prototype !== Object.prototype
    )
      return false;
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return false;
    ancestors.add(value);
    stack.push({ value, depth, leaving: true });
    for (const key of Object.keys(value)) {
      if (forbiddenKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) return false;
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  return true;
}

export function validateOps(input: unknown): Op[] | null {
  if (!Array.isArray(input) || input.length > 5000 || !isSafeJson(input)) return null;
  const result = operations.safeParse(input);
  return result.success ? result.data : null;
}
