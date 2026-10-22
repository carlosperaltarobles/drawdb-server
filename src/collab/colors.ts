// Mantener sincronizado con la paleta y el hash de FE/src/collab/colors.js.
export const COLORS = Object.freeze([
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#db2777',
  '#4f46e5',
  '#65a30d',
  '#0d9488',
  '#c026d3',
  '#ca8a04',
]);

export function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}
