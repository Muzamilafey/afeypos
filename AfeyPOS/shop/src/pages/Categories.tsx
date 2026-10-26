import { Container, Crumbs } from '../components/Layout';
import { CategoryCircle, useCategoryTiles } from '../components/Sections';

export function CategoriesPage() {
  const tiles = useCategoryTiles();
  return (
    <Container>
      <Crumbs items={[{ label: 'Categories' }]} />
      <h1 className="section-title mb-8">Shop by Category</h1>
      {tiles.length ? <div className="grid grid-cols-2 justify-items-center gap-8 sm:grid-cols-4 lg:grid-cols-6">{tiles.map((c, i) => <CategoryCircle key={i} c={c} />)}</div> : <p className="text-ink-500">No categories yet.</p>}
    </Container>
  );
}
