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
        /* OPUS-M2-002 — the SP-E §4 extensions, each resolving to a token whose
           contrast is computed by `scripts/contrast.mjs` and rendered (and
           therefore axe-measured) by `e2e/catalogue.spec.ts`. */
        success: 'var(--sp-color-success)',
        warning: 'var(--sp-color-warning)',
        focus: 'var(--sp-color-focus)',
        'shift-neutral': 'var(--sp-color-shift-neutral-surface)',
        'shift-neutral-ink': 'var(--sp-color-shift-neutral-ink)',
        'shift-indigo': 'var(--sp-color-shift-indigo-surface)',
        'shift-indigo-ink': 'var(--sp-color-shift-indigo-ink)',
        'shift-teal': 'var(--sp-color-shift-teal-surface)',
        'shift-teal-ink': 'var(--sp-color-shift-teal-ink)',
        'shift-amber': 'var(--sp-color-shift-amber-surface)',
        'shift-amber-ink': 'var(--sp-color-shift-amber-ink)',
        'shift-rose': 'var(--sp-color-shift-rose-surface)',
        'shift-rose-ink': 'var(--sp-color-shift-rose-ink)',
        'shift-violet': 'var(--sp-color-shift-violet-surface)',
        'shift-violet-ink': 'var(--sp-color-shift-violet-ink)',
      },
      fontSize: {
        sm: ['var(--sp-text-sm)', { lineHeight: '1.5' }],
        base: ['var(--sp-text-base)', { lineHeight: '1.5' }],
        lg: ['var(--sp-text-lg)', { lineHeight: '1.4' }],
        xl: ['var(--sp-text-xl)', { lineHeight: '1.3' }],
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
        // The SP-E §4 spacing scale. Components use `gap-sp-4`, never `gap-4`,
        // so a spacing change is a token change rather than a sweep.
        'sp-1': 'var(--sp-space-1)',
        'sp-2': 'var(--sp-space-2)',
        'sp-3': 'var(--sp-space-3)',
        'sp-4': 'var(--sp-space-4)',
        'sp-5': 'var(--sp-space-5)',
        'sp-6': 'var(--sp-space-6)',
        'sp-7': 'var(--sp-space-7)',
        'sp-8': 'var(--sp-space-8)',
      },
    },
  },
  plugins: [],
};
