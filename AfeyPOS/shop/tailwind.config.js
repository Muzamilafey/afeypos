/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand colours come from the Store studio (CSS variables set at runtime).
        primary: 'var(--c-primary)',
        accent: 'var(--c-accent)',
        soft: 'var(--c-soft)',
        foot: 'var(--c-footer)',
        ink: { 50: '#f8f7f4', 100: '#f0eee9', 200: '#e3e0d8', 300: '#cbc6ba', 400: '#9a9488', 500: '#6f6a5f', 600: '#545047', 700: '#3d3a33', 800: '#2a2823', 900: '#1b1a17' },
      },
      borderRadius: { box: 'var(--r-box)', tile: 'var(--r-tile)' },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        hand: ['Caveat', 'cursive'],
      },
      maxWidth: { shop: '80rem' },
    },
  },
  plugins: [],
};
