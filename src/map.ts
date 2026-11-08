import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TILE_URL } from './card/tiles';
import type { Area } from './types';

export function createMap(el: HTMLElement) {
  const map = L.map(el, { zoomSnap: 0.25, attributionControl: false }).setView([10.0, 76.3], 11);
  L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);
  return map;
}

export const toLatLngs = (a: Area): L.LatLngExpression[][] | L.LatLngExpression[][][] => {
  const ring = (r: number[][]) => r.map(([x, y]) => [y, x] as [number, number]);
  return a.type === 'Polygon' ? a.coordinates.map(ring) : a.coordinates.map((p) => p.map(ring));
};

const PALETTE = ['#c0392b', '#2471a3', '#1e8449', '#b9770e', '#7d3c98', '#117a65', '#a04000', '#2e4053'];
export const colorFor = (i: number) => PALETTE[i % PALETTE.length];

export function bboxOf(a: Area): [number, number, number, number] {
  const pts = (a.type === 'Polygon' ? a.coordinates : a.coordinates.flat()).flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
