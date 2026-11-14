import { describe, expect, it } from 'vitest';
import { isGoogleMap, parseLinks, previewLink } from '../src/links';

describe('QR links', () => {
  it('turns My Maps edit links into view links', () => {
    expect(previewLink('https://www.google.com/maps/d/u/0/edit?mid=ABC_123&ll=8.27%2C77.43&z=15')).toBe('https://www.google.com/maps/d/viewer?mid=ABC_123');
    expect(previewLink('https://www.google.com/maps/d/viewer?mid=XYZ')).toBe('https://www.google.com/maps/d/viewer?mid=XYZ');
    expect(previewLink('https://maps.app.goo.gl/abc')).toBe('https://maps.app.goo.gl/abc');
    expect(previewLink('javascript:alert(1)')).toBe('');
  });

  it('reads one "number link" per line', () => {
    expect(parseLinks('1 https://www.google.com/maps/d/edit?mid=A\n12\thttps://maps.app.goo.gl/b\nnot a line\n3, https://x.y/z')).toEqual([
      { number: '1', url: 'https://www.google.com/maps/d/viewer?mid=A' },
      { number: '12', url: 'https://maps.app.goo.gl/b' },
      { number: '3', url: 'https://x.y/z' },
    ]);
  });

  it('knows which links are Google maps', () => {
    expect(isGoogleMap('https://www.google.com/maps/d/viewer?mid=A')).toBe(true);
    expect(isGoogleMap('https://maps.app.goo.gl/b')).toBe(true);
    expect(isGoogleMap('https://evil-google.com.example/x')).toBe(false);
    expect(isGoogleMap(undefined)).toBe(false);
  });
});
