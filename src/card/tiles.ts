// On-screen maps use standard OpenStreetMap raster tiles; printed cards use OpenFreeMap vector
// tiles so labels stay sharp at 300 dpi. Both are free and need no API key.
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const CARD_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
