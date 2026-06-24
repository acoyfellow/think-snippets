// OG card for think.coey.dev — V4 editorial palette.
// Cream paper background, ink-black serif italic title (Fraunces), grays,
// orange accent rule, and ONE blue dot — exactly the constraint the page uses.
// astro-og-canvas renders this as a static PNG at /og/index.png at build time.

import { OGImageRoute } from 'astro-og-canvas';

interface PageData { title: string; description: string }
const pages: Record<string, PageData> = {
  index: {
    // The hero phrasing on the site is "Things that survive a redeploy."
    // OG echoes it so social preview, page, and tweet read as one piece.
    title: 'Things that survive a redeploy.',
    description: 'Field notes — fifteen Cloudflare Project Think contracts that deploy, prove, and tear themselves down.',
  },
};

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'route',
  pages,
  getImageOptions: (_path, page: PageData) => ({
    title: page.title,
    description: page.description,
    // Cream paper, matches body background (#f5f3ef).
    bgGradient: [
      [245, 243, 239],
      [236, 234, 224],
    ],
    // Orange-accent rule on the inline-start, the same brand bar the page
    // uses everywhere we want to draw the eye to "live".
    border: { color: [242, 91, 28], width: 14, side: 'inline-start' },
    padding: 80,
    font: {
      title: {
        color: [15, 15, 15],
        size: 84,
        weight: 'Bold',
        lineHeight: 1.0,
        families: ['Fraunces'],
      },
      description: {
        color: [59, 59, 59],
        size: 30,
        weight: 'Normal',
        lineHeight: 1.36,
        families: ['Fraunces'],
      },
    },
    fonts: [
      './src/fonts/Fraunces-Italic-VF.ttf',
      './src/fonts/Fraunces-VF.ttf',
    ],
  }),
});
