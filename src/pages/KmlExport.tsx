import { downloadAllKml, downloadEachKml } from '../geo/kml';
import type { Territory } from '../types';

/** Buttons to save the territories as KML, to check them in Google Earth / My Maps or keep a copy outside the app. */
export default function KmlExport({ territories, congregation }: { territories: Territory[]; congregation: string }) {
  if (!territories.length) return null;
  return (
    <div className="dl-list">
      <button className="btn" onClick={() => downloadAllKml(territories, congregation)}>
        All {territories.length} territories in one KML
      </button>
      <button className="btn" onClick={() => downloadEachKml(territories, congregation)}>
        Each territory as its own KML (ZIP)
      </button>
    </div>
  );
}
