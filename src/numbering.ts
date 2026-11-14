// Number territories from their names: "House to House 12" becomes territory 12.
import type { Territory } from './types';

/** The new numbers by territory id, or the reason it cannot be done (a name without a number, or two names with the same one). */
export function numbersFromNames(ts: Pick<Territory, 'id' | 'locality'>[]): { numbers: Map<string, string> } | { problem: string } {
  const numbers = new Map<string, string>();
  const owner = new Map<string, string>();
  const without: string[] = [];
  const twice = new Set<string>();
  for (const t of ts) {
    const n = t.locality.match(/(\d+)\D*$/)?.[1]?.replace(/^0+(?=\d)/, '');
    if (!n) {
      without.push(t.locality.trim() || '(no name)');
      continue;
    }
    if (owner.has(n)) twice.add(n);
    owner.set(n, t.id);
    numbers.set(t.id, n);
  }
  if (without.length) return { problem: `${without.length} name${without.length === 1 ? ' has' : 's have'} no number: ${without.slice(0, 5).join(', ')}${without.length > 5 ? ' …' : ''}` };
  if (twice.size) return { problem: `More than one name ends in ${[...twice].join(', ')}.` };
  return { numbers };
}
