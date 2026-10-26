/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Admin template palette: blue primary, charcoal sidebar, light grey canvas, four tile colours.
        brand: { 50: '#eef5fd', 100: '#d9e8fb', 200: '#b4d1f6', 300: '#86b5ef', 400: '#5e9be7', 500: '#4a8ae0', 600: '#3a76cc', 700: '#2f60a8', 800: '#284f88', 900: '#213f6b' },
        canvas: { DEFAULT: '#eef0f3', dark: '#14171c' },
        side: { DEFAULT: '#2a2e35', hover: '#333841', active: '#3b414b', text: '#c3c8cf', muted: '#7d858f', top: '#23272d' },
        tile: { purple: '#9b7fd6', blue: '#4a9be3', red: '#e8625b', yellow: '#f3c24c', green: '#62b86f', teal: '#3fb8b0' },
        mint: { 100: '#e3f3e6', 600: '#3e8c4b' },
        peach: { 50: '#fdf0ef', 100: '#fbdedc', 300: '#f3aba6', 500: '#e8625b', 700: '#b83f39' },
        ink: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
      },
      fontFamily: { sans: ['Open Sans', 'Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'] },
    },
  },
  plugins: [],
};
