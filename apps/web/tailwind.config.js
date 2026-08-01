/**
 * Tailwind reads the design tokens; it never defines them.
 *
 * Every colour, radius and spacing value below resolves to a CSS custom
 * property declared in `src/styles/tokens.css`. That indirection is the point
 * of TDG-14: the tokens are the contract SPEC-14's accessibility matrix binds
 * to, and they must stay independent of the utility framework so the framework
 * can be replaced without renegotiating the palette.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'var(--sp-color-surface)',
        'surface-raised': 'var(--sp-color-surface-raised)',
        border: 'var(--sp-color-border)',
        text: 'var(--sp-color-text)',
        'text-muted': 'var(--sp-color-text-muted)',
        accent: 'var(--sp-color-accent)',
        'accent-contrast': 'var(--sp-color-accent-contrast)',
        danger: 'var(--sp-color-danger)',
      },
      borderRadius: {
        control: 'var(--sp-radius-control)',
        panel: 'var(--sp-radius-panel)',
      },
      fontFamily: {
        sans: 'var(--sp-font-sans)',
      },
      spacing: {
        // Minimum interactive target. SPEC-14 / SP-HR-4 requires 44px; it is a
        // token rather than a magic number so the axe/manual matrix can cite it.
        target: 'var(--sp-size-target)',
      },
    },
  },
  plugins: [],
};
