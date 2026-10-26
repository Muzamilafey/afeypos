import { Banners, CategoryStrip, Hero, Newsletter, ProductRail, WhyUs } from '../components/Sections';

export function HomePage() {
  return (
    <>
      <Hero />
      <CategoryStrip />
      <ProductRail section="featured" />
      <ProductRail section="deals" />
      <Banners />
      <ProductRail section="newArrivals" />
      <ProductRail section="bestSellers" />
      <WhyUs />
      <Newsletter />
    </>
  );
}
