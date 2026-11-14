// Number territories from their names: "House to House 12" becomes territory 12.
import type { Territory } from './types';

type T = Pick<Territory, 'id' | 'number' | 'locality'>;
const nameNumber = (s: string) => s.match(/(\d+)\D*$/)?.[1]?.replace(/^0+(?=\d)/, '');
const label = (t: T) => `${t.number} (${t.locality.trim() || 'no name'})`;

/**
 * New numbers (and fixed names) by territory id. Every territory that can take its name's number does.
 * A name used twice: the copy whose current number differs is renamed to its current number, when no other name uses it.
 * Anything that cannot be settled keeps its number and name, and is listed in `log`.
 */
export function numbersFromNames(ts: T[]): { numbers: Map<string, string>; names: Map<string, string>; log: string[] } {
  const numbers = new Map<string, string>();
  const names = new Map<string, string>();
  const log: string[] = [];
  const byName = new Map<string, T[]>();
  for (const t of ts) {
    const n = nameNumber(t.locality);
    if (!n) log.push(`${label(t)}: the name has no number, left as it is.`);
    else byName.set(n, [...(byName.get(n) ?? []), t]);
  }
  for (const [n, group] of byName) {
    const keeper = group.find((t) => t.number === n) ?? (group.length === 1 ? group[0] : undefined);
    if (keeper) numbers.set(keeper.id, n);
    for (const t of group) {
      if (t === keeper) continue;
      if (t.number !== n && !byName.has(t.number) && /^\d+$/.test(t.number)) {
        const renamed = t.locality.replace(/(\d+)(\D*)$/, `${t.number}$2`);
        names.set(t.id, renamed);
        numbers.set(t.id, t.number);
        log.push(`${label(t)}: "${t.locality.trim()}" is used twice, renamed to "${renamed.trim()}".`);
      } else log.push(`${label(t)}: "${t.locality.trim()}" is used ${group.length} times, left as it is.`);
    }
  }
  // Territories left alone keep their number unless a renumbered one now has it; then they take a free number.
  const taken = new Set(numbers.values());
  let next = Math.max(0, ...ts.map((t) => Number(nameNumber(t.locality) ?? t.number) || 0)) + 1;
  for (const t of ts) {
    if (numbers.has(t.id)) continue;
    if (taken.has(t.number)) {
      while (taken.has(String(next))) next++;
      log.push(`${label(t)}: its number now belongs to another territory, so it became ${next}.`);
      numbers.set(t.id, String(next));
    } else numbers.set(t.id, t.number);
    taken.add(numbers.get(t.id)!);
  }
  return { numbers, names, log };
}
