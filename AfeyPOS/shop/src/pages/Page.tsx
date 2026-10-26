import { useParams } from 'react-router-dom';
import { useStore } from '../lib/store';
import { Container, Crumbs } from '../components/Layout';

/** Information pages written in Store studio (About, Delivery, FAQ...). Plain text: blank lines start paragraphs, lines ending in "?" are questions. */
export function InfoPage() {
  const { slug } = useParams();
  const { studio } = useStore();
  const page = studio.pages.find((p) => p.slug === slug);
  if (!page) return <Container><p className="py-16 text-center text-ink-500">Page not found</p></Container>;
  return (
    <Container className="max-w-3xl">
      <Crumbs items={[{ label: page.title }]} />
      <article className="rounded-box bg-soft px-6 py-10 sm:px-12">
        <h1 className="text-3xl font-extrabold">{page.title}</h1>
        <div className="mt-6 space-y-4 leading-relaxed text-ink-700">
          {page.body.split(/\n{2,}/).map((para, i) => (
            <div key={i}>{para.split('\n').map((line, j) => (/\?\s*$/.test(line) ? <h2 key={j} className="mb-1 text-lg font-bold">{line}</h2> : <p key={j}>{line}</p>))}</div>
          ))}
        </div>
      </article>
    </Container>
  );
}
