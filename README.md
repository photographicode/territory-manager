# Territory Manager

Makes congregation territory cards from one boundary KML, and keeps the record of who has each territory.
Standalone for now (React + Vite + TypeScript, same stack as congregation-assistant) so it can be moved in later.

## Workflow

1. **Boundary**: import the congregation outline (`.kml`/`.kmz` exported from Google My Maps). You can also import existing territories (one shape per territory).
2. **Split**: download OpenStreetMap roads, railways, water and buildings, then split automatically.
   - It cuts along the biggest borders first (railway, rivers/canals, main roads), then secondary roads, local roads and lanes, but only inside pieces that still have more than the maximum number of houses.
   - Pieces with fewer than the minimum number of houses are joined to the neighbour they share the longest border with.
   - If no road crosses a piece that is still too large, it is cut in half with a straight line and marked **check**.
   - Lakes, ponds and rivers are left out of territories.
3. **Review**: merge (select several with Shift/Ctrl-click), cut with a drawn line, drag outline corners, delete, renumber north→south, suggest locality names from OpenStreetMap (English/Malayalam/local), and undo.
4. **Cards**: 6 × 4 inch cards at 300 dpi with the map, locality, number, instructions (any language) and a QR code. Download one PDF of all cards, or a KML of all territories for My Maps.
5. **Territories**: assign to a publisher, mark returned, view history, export the record as CSV.

**Backup** downloads everything as JSON. Data is stored only in this browser (IndexedDB).

## QR codes

The QR opens `view.html`, a page that draws the exact outline, shows your location, and has Google Maps / Apple Maps direction buttons and a KML download.
The outline is stored in the link itself (after `#`), so no server or database is needed and the link never expires.
Google has no API to create My Maps automatically; a territory can still use a hand-made My Maps link instead (Cards → "Own map link").

**Before printing**, publish the `dist/` folder (e.g. GitHub Pages) and set *Public map page address* on the Cards step to its `view.html` address. A `localhost` address only works on the computer running the app.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm test
npm run build   # outputs dist/
```

Map data © OpenStreetMap contributors. Card maps by OpenFreeMap. Both are free and need no API key.
Keep the browser tab visible while making PDFs; browsers pause map drawing in hidden tabs.
