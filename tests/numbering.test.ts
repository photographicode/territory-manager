import { describe, expect, it } from 'vitest';
import { numbersFromNames } from '../src/numbering';

describe('numbers from names', () => {
  it('takes the number at the end of each name', () => {
    const r = numbersFromNames([{ id: 'a', locality: 'House to House 12' }, { id: 'b', locality: 'Town 03 (east)' }]);
    expect('numbers' in r && [...r.numbers]).toEqual([['a', '12'], ['b', '3']]);
  });
  it('refuses names without a number or with the same number', () => {
    expect(numbersFromNames([{ id: 'a', locality: 'Market' }])).toHaveProperty('problem');
    expect(numbersFromNames([{ id: 'a', locality: 'A 1' }, { id: 'b', locality: 'B 1' }])).toEqual({ problem: 'More than one name ends in 1.' });
  });
});
