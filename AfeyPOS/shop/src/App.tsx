import { Route, Routes } from 'react-router-dom';
import { Container, Layout } from './components/Layout';
import { HomePage } from './pages/Home';
import { ShopPage } from './pages/Shop';
import { CategoriesPage } from './pages/Categories';
import { ProductPage } from './pages/Product';
import { CartPage } from './pages/Cart';
import { CheckoutPage } from './pages/Checkout';
import { AccountPage, OrderPage, TrackPage } from './pages/Order';
import { WishlistPage } from './pages/Wishlist';
import { InfoPage } from './pages/Page';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/p/:id" element={<ProductPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/order/:number" element={<OrderPage />} />
        <Route path="/track" element={<TrackPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/wishlist" element={<WishlistPage />} />
        <Route path="/page/:slug" element={<InfoPage />} />
        <Route path="*" element={<Container><p className="py-16 text-center text-ink-500">Page not found</p></Container>} />
      </Routes>
    </Layout>
  );
}
