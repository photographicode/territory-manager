// MapLibre 6 looks for its worker file next to its own module, but the bundle has no such file,
// so maps never load in a build. Ship the worker as an asset and point MapLibre at it.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

export * from 'maplibre-gl';
