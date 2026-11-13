// Public map page opened from a card's QR code. Everything it needs is in the URL fragment,
// which browsers never send to the server.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './viewer.css';
import { decodeArea } from './geo/codec';
import { download, gpxDocument, kmlDocument, placemark } from './geo/kml';
import { TILE_URL } from './card/tiles';

const params = new URLSearchParams(location.hash.slice(1));
const number = params.get('t') ?? '';
const locality = params.get('n') ?? '';
// The number comes from the link; keep only characters that are safe in a file name.
const safeName = number.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 40);
const $ = (id: string) => document.getElementById(id)!;
$('num').textContent = number ? `Territory ${number}` : 'Territory';
$('name').textContent = locality;
document.title = [number && `Territory ${number}`, locality].filter(Boolean).join(' – ') || 'Territory Map';

const map = L.map('map', { zoomControl: true, attributionControl: false });
L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);

try {
  const area = decodeArea(params.get('g') ?? '');
  const toLatLng = (r: number[][]) => r.map(([x, y]) => [y, x] as [number, number]);
  const latlngs = area.type === 'Polygon' ? area.coordinates.map(toLatLng) : area.coordinates.map((p) => p.map(toLatLng));
  const shape = L.polygon(latlngs as L.LatLngExpression[][], { color: '#a5281b', weight: 4, fillColor: '#c0392b', fillOpacity: 0.2 }).addTo(map);
  map.fitBounds(shape.getBounds(), { padding: [24, 24] });
  const c = shape.getBounds().getCenter();
  const ll = `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`;
  ($('gmaps') as HTMLAnchorElement).href = `https://www.google.com/maps/dir/?api=1&destination=${ll}`;
  ($('amaps') as HTMLAnchorElement).href = `https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(document.title)}`;
  $('kml').onclick = () =>
    download(`territory-${safeName || 'map'}.kml`, kmlDocument(document.title, [placemark(document.title, area)]), 'application/vnd.google-earth.kml+xml');
  $('gpx').onclick = () => download(`territory-${safeName || 'map'}.gpx`, gpxDocument(document.title, area), 'application/gpx+xml');
} catch {
  map.setView([10, 76.3], 9);
  $('name').textContent = 'This link is incomplete. Please scan the card again.';
}

let me: L.CircleMarker | null = null;
let accuracy: L.Circle | null = null;
let first = true;
$('locate').onclick = () => {
  if (!navigator.geolocation) return alert('Location is not available on this device.');
  navigator.geolocation.watchPosition(
    (pos) => {
      const p = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (!me) {
        accuracy = L.circle(p, { radius: pos.coords.accuracy, weight: 0, fillColor: '#1a73e8', fillOpacity: 0.12 }).addTo(map);
        me = L.circleMarker(p, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
      }
      me.setLatLng(p);
      accuracy!.setLatLng(p).setRadius(pos.coords.accuracy);
      if (first) map.panTo(p);
      first = false;
    },
    (err) => alert(`Could not get your location: ${err.message}`),
    { enableHighAccuracy: true },
  );
};
