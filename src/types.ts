import type { Feature, MultiPolygon, Polygon } from 'geojson';

export type Area = Polygon | MultiPolygon;

export interface Territory {
  id: string;
  number: string;
  locality: string;
  geometry: Area;
  /** Buildings counted from OpenStreetMap inside the boundary. */
  buildings: number;
  notes?: string;
  /** Part of the outline is a straight cut, not a road; worth checking on the ground. */
  needsCheck?: boolean;
  /** Optional override for the QR link, e.g. a hand-made Google My Maps link. */
  mapUrl?: string;
  /** Held for someone (e.g. a group or campaign) but not yet handed out. */
  reservation?: Reservation;
}

export interface Reservation {
  for: string;
  on: string; // yyyy-mm-dd
  note?: string;
}

export type TerritoryStatus = 'never' | 'available' | 'inuse' | 'reserved';

export const STATUS_LABEL: Record<TerritoryStatus, string> = {
  never: 'Never used',
  available: 'Available',
  inuse: 'In use',
  reserved: 'Reserved',
};

export function statusOf(t: Territory, assignments: Assignment[]): TerritoryStatus {
  const mine = assignments.filter((a) => a.territoryId === t.id);
  if (mine.some((a) => !a.completedOn)) return 'inuse';
  if (t.reservation) return 'reserved';
  return mine.length ? 'available' : 'never';
}

export interface Assignment {
  id: string;
  territoryId: string;
  publisher: string;
  assignedOn: string; // yyyy-mm-dd
  completedOn?: string;
  note?: string;
}

/** The most territories a split may make; more is too many to manage. */
export const MAX_TERRITORIES = 250;

export interface Settings {
  congregation: string;
  /** Split into a set number of territories, or by houses per territory. */
  sizeMode: 'count' | 'houses';
  /** Wanted number of territories; 0 until chosen. */
  territoryCount: number;
  minBuildings: number;
  maxBuildings: number;
  /** Border levels used for splitting: major, secondary, local, lanes. */
  levels: [boolean, boolean, boolean, boolean];
  cardTitle: string;
  localityLabel: string;
  numberLabel: string;
  footerText: string;
  /** Public address of view.html for QR codes; empty means the site this app runs on. */
  viewerUrl: string;
}

export type Stage = 'boundary' | 'split' | 'review' | 'cards' | 'assign' | 'settings';
export type Section = 'territories' | 'make' | 'print' | 'backup';

export interface Project {
  version: 1;
  boundary?: Feature<Area>;
  territories: Territory[];
  assignments: Assignment[];
  settings: Settings;
  /** True once the review stage has been confirmed. */
  finalized: boolean;
}

export interface OsmData {
  bbox: [number, number, number, number];
  fetchedAt: string;
  /** Barrier lines; level 0 = major (rail, river, primary roads) .. 3 = lanes. */
  lines: { level: number; coords: [number, number][] }[];
  water: Area[];
  buildings: [number, number][];
  /** Named places; `names` holds `default` plus language codes such as `en`, `ml`. */
  places: { names: Record<string, string>; kind: string; at: [number, number] }[];
}

export const defaultSettings = (): Settings => ({
  congregation: '',
  sizeMode: 'count',
  territoryCount: 0,
  minBuildings: 150,
  maxBuildings: 250,
  levels: [true, true, true, true],
  cardTitle: 'Territory Map Card',
  localityLabel: 'Locality',
  numberLabel: 'Terr. No.',
  footerText:
    'Please keep this card in the envelope. Do not soil, mark or bend it. Each time the territory is covered, please inform the brother who cares for the territory files.',
  viewerUrl: '',
});

export const newProject = (): Project => ({
  version: 1,
  territories: [],
  assignments: [],
  settings: defaultSettings(),
  finalized: false,
});

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
