/** Line icons (24×24, stroke) for the studio choices and the shop UI. Brand marks are simplified glyphs. */
const PATHS: Record<string, string> = {
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7M7.5 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  return: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3.5-5-1s3 1 5 1zm0 0c1.5-3 5-3.5 5-1s-3 1-5 1z',
  leaf: 'M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19c3-4 6-6 10-8',
  heart: 'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6zM9 12l2 2 4-4',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  basket: 'M3 10h18l-2 10H5zM7 10l4-6M17 10l-4-6M9 14v3M15 14v3M12 14v3',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'm5 12 4 4 10-10',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  facebook: 'M14 8h3V4h-3a4 4 0 0 0-4 4v2H7v4h3v7h4v-7h3l1-4h-4V8z',
  instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17.5 6.5h.01',
  youtube: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 9v6l5-3z',
  pinterest: 'M12 21a9 9 0 1 0-3.3-.6M10.5 13.5 9 21M9.5 14c.5 1 1.5 1.5 2.5 1.5 2.5 0 4-2.2 4-5S14 6 11.5 6 7 8 7 10.5c0 1 .4 2 1 2.5',
  tiktok: 'M14 3v11.5a3.5 3.5 0 1 1-3-3.5M14 3c.5 2.5 2.5 4.5 5 4.5',
  x: 'M4 4l16 16M20 4 4 20',
  whatsapp: 'M4 20l1.3-4A8 8 0 1 1 8 18.7zM9 9c0 3 3 6 6 6l1-1.5-2-1-1 1c-1 0-2.5-1.5-2.5-2.5l1-1-1-2z',
  play: 'M6 4v16l13-8z',
  apple: 'M15 4c-1 0-2.5 1-2.8 2.5 1.2 0 2.6-1 2.8-2.5zM12 8c-1-.5-2-.7-3-.5C6.5 8 5 10.5 5 13c0 3.5 2.5 7 4 7 1 0 1.8-.6 3-.6s2 .6 3 .6c1.4 0 3-2.4 3.6-4.4-1.6-.7-2.6-2.1-2.6-3.8 0-1.4.7-2.6 1.9-3.3-.8-1-2-1.5-3.2-1.5-1 0-1.9.4-2.7 1z',
};

export type IconName = keyof typeof PATHS | string;

export function Icon({ name, className = 'h-5 w-5', filled = false, title }: { name: IconName; className?: string; filled?: boolean; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS.sparkle} />
    </svg>
  );
}
