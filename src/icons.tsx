// Small line icons (24×24, stroke = currentColor), so the app needs no icon package.
const PATHS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  boundary: 'M4 6l5-3 6 3 5-3v15l-5 3-6-3-5 3zM9 3v15M15 6v15',
  split: 'M6 3v18M18 3v18M6 12h12M12 3v9',
  review: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  cards: 'M3 6h18v12H3zM7 10h6M7 14h4M16 10h2v4h-2z',
  print: 'M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z',
  poster: 'M4 3h16v18H4zM8 7h8M8 11l3 3 2-2 3 3',
  territories: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  backup: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  check: 'M5 12l5 5L20 7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
