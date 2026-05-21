import { OGImageRoute } from 'astro-og-canvas';

interface PageData { title: string; description: string }
const pages: Record<string, PageData> = {
  index: {
    title: 'Think contracts that actually run',
    description: '14 deployable Cloudflare Project Think examples. Real probes. Real cleanup.',
  },
};

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'route',
  pages,
  getImageOptions: (_path, page: PageData) => ({
    title: page.title,
    description: page.description,
    bgGradient: [[23, 18, 13], [53, 40, 27]],
    border: { color: [243, 128, 32], width: 14, side: 'inline-start' },
    padding: 72,
    font: {
      title: { color: [255, 250, 241], size: 78, weight: 'Bold', lineHeight: 1.08, families: ['JetBrains Mono'] },
      description: { color: [226, 211, 190], size: 34, weight: 'Bold', lineHeight: 1.38, families: ['JetBrains Mono'] },
    },
    fonts: ['./src/fonts/JetBrainsMono-Bold.ttf'],
  }),
});
