import { useEffect, useState } from 'react';

/**
 * True when the viewport is too narrow for a wide data table.
 *
 * ## Why this is a hook and not a CSS breakpoint
 *
 * SPEC-14's schedule-grid row and the SP-E brief both require a **list
 * alternative** for grids at 320px, and CSS can only hide — it cannot choose.
 * Rendering both and hiding one puts every row in the accessibility tree twice:
 * a screen-reader user hears the catalogue, then hears it again. Choosing in
 * JavaScript keeps exactly one representation in the DOM.
 *
 * The threshold is 640px because that is where a six-column catalogue table
 * stops fitting; below it the same rows render as a definition list, which
 * carries the same information with no horizontal scrolling (SC 1.4.10).
 *
 * `matchMedia` rather than a resize listener: it fires only when the answer
 * changes, so a drag-resize does not re-render on every frame.
 */
export function useNarrowViewport(maxWidth = 639): boolean {
  const query = `(max-width: ${String(maxWidth)}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return narrow;
}
