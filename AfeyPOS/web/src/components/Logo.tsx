/** The Afey brand mark (see docs/brand). Served from /logo.svg so it is cached and also used as the favicon. */
export function Logo({ className = 'h-10 w-auto', title = 'Afey POS' }: { className?: string; title?: string }) {
  return <img src="/logo.svg" alt={title} className={className} draggable={false} />;
}
