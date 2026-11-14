import { describe, expect, it } from 'vitest';
import { numbersFromNames } from '../src/numbering';

describe('numbers from names', () => {
  it('numbers every territory whose name has a number', () => {
    const r = numbersFromNames([
      { id: 'a', number: '2', locality: 'House to House 1' },
      { id: 'b', number: '1', locality: 'House to House 2' },
    ]);
    expect([...r.numbers]).toEqual([['a', '1'], ['b', '2']]);
    expect(r.log).toEqual([]);
  });

  it('renames a duplicate to its own number, logs what it leaves alone', () => {
    const r = numbersFromNames([
      { id: 'a', number: '89', locality: 'House to House 89' },
      { id: 'b', number: '73', locality: 'House to House 89' },
      { id: 'c', number: '5', locality: 'Market' },
    ]);
    expect(r.numbers.get('a')).toBe('89');
    expect(r.numbers.get('b')).toBe('73');
    expect(r.names.get('b')).toBe('House to House 73');
    expect(r.numbers.get('c')).toBe('5');
    expect(r.log.length).toBe(2);
  });

  it('moves a left-alone territory off a number that is now taken', () => {
    const r = numbersFromNames([
      { id: 'a', number: '1', locality: 'Market' },
      { id: 'b', number: '9', locality: 'House to House 1' },
    ]);
    expect(r.numbers.get('b')).toBe('1');
    expect(r.numbers.get('a')).toBe('2');
    expect(new Set(r.numbers.values()).size).toBe(2);
  });
});
