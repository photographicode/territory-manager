import { describe, expect, it } from 'vitest';
import { IMPORT, parseImport } from '../src/handoff';

const bytes = () => new TextEncoder().encode('<kml></kml>').buffer as ArrayBuffer;
const msg = (origin: string, data: unknown) => ({ origin, data });

describe('dashboard handoff', () => {
  it('accepts a KML from the territory site', () => {
    const got = parseImport(msg('https://territory.congregationassistant.com', { type: IMPORT, name: 'folder/sub/aroor.kml', congregation: ' Aroor ', bytes: bytes() }));
    expect(got?.file.name).toBe('aroor.kml');
    expect(got?.congregation).toBe('Aroor');
  });
  it('rejects other origins, other types and bad files', () => {
    const good = { type: IMPORT, name: 'a.kml', congregation: '', bytes: bytes() };
    expect(parseImport(msg('https://evil.example', good))).toBeNull();
    expect(parseImport(msg('https://territory.congregationassistant.com', { ...good, type: 'other' }))).toBeNull();
    expect(parseImport(msg('https://territory.congregationassistant.com', { ...good, name: 'a.exe' }))).toBeNull();
    expect(parseImport(msg('https://territory.congregationassistant.com', { ...good, bytes: new ArrayBuffer(0) }))).toBeNull();
    expect(parseImport(msg('https://territory.congregationassistant.com', { ...good, bytes: 'text' }))).toBeNull();
  });
});
