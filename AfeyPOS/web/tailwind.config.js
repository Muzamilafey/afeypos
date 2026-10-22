/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Afey charcoal, taken from the logo (#3c3b39 = brand-600)
        brand: { 50: '#f5f5f4', 100: '#e7e6e4', 200: '#cfcdca', 300: '#a9a7a2', 400: '#7d7b76', 500: '#57554f', 600: '#3c3b39', 700: '#2f2e2c', 800: '#242322', 900: '#191817' },
        ink: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'] },
    },
  },
  plugins: [],
};
