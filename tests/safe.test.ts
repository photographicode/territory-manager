import { describe, expect, it } from 'vitest';
import { backupProblem, csvCell, safeUrl, validArea } from '../src/safe';
import { newProject } from '../src/types';

const square = { type: 'Polygon', coordinates: [[[76.3, 9.88], [76.31, 9.88], [76.31, 9.89], [76.3, 9.88]]] };

describe('safe output', () => {
  it('lets only web links into QR codes', () => {
    expect(safeUrl('https://maps.google.com/x')).toBe('https://maps.google.com/x');
    expect(safeUrl(' http://a.b/ ')).toBe('http://a.b/');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'tel:123', 'not a url', '', undefined]) expect(safeUrl(bad)).toBe('');
  });
  it('keeps spreadsheet cells from becoming formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('Aroor, North')).toBe('"Aroor, North"');
    expect(csvCell(42)).toBe('42');
  });
  it('checks backups before restoring', () => {
    const good = { ...newProject(), territories: [{ id: 'a', number: '1', locality: 'X', geometry: square, buildings: 1 }] };
    expect(backupProblem(good)).toBe('');
    expect(backupProblem({ version: 2, territories: [] })).toMatch(/not a Territory Manager backup/);
    expect(backupProblem({ ...good, territories: [{ id: 'a', number: '1', locality: 'X', geometry: { type: 'Point', coordinates: [1, 2] } }] })).toMatch(/damaged/);
    expect(backupProblem({ ...good, settings: { ...good.settings, viewerUrl: 'javascript:alert(1)' } })).toMatch(/not a web address/);
    expect(backupProblem(null)).toMatch(/not a Territory Manager backup/);
  });
  it('validates outlines', () => {
    expect(validArea(square)).toBe(true);
    expect(validArea({ type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] })).toBe(false);
    expect(validArea({ type: 'MultiPolygon', coordinates: [[square.coordinates[0]]] })).toBe(true);
  });
});
