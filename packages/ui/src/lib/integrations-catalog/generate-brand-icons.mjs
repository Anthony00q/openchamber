import fs from 'node:fs';

/**
 * Pulls official brand glyphs from simple-icons (CC0 paths) and writes the
 * brand-icons module. Rendered monochrome on the muted surface tile, in
 * OpenChamber's style. Brands missing from simple-icons fall back to the
 * generic sprite icon in the view.
 */
const TARGET = new URL('./brand-icons.ts', import.meta.url).pathname;

/** Catalog entry id → simple-icons slug. */
const BRANDS = {
  linear: 'linear',
  atlassian: 'atlassian',
  notion: 'notion',
  asana: 'asana',
  gitlab: 'gitlab',
  figma: 'figma',
  supabase: 'supabase',
  stripe: 'stripe',
  cloudflare: 'cloudflare',
  vercel: 'vercel',
  sentry: 'sentry',
  huggingface: 'huggingface',
  datadog: 'datadog',
  github: 'github',
  postman: 'postman',
  context7: 'upstash',
  mongodb: 'mongodb',
  'google-cloud': 'googlecloud',
  grafana: 'grafana',
  terraform: 'terraform',
  snyk: 'snyk',
  'openai-pdf': 'openai',
  'langsmith-plugin': 'langchain',
};

const lines = [];
for (const [id, slug] of Object.entries(BRANDS)) {
  const response = await fetch(`https://unpkg.com/simple-icons@15/icons/${slug}.svg`);
  if (!response.ok) {
    console.log(`${id} (${slug}): MISS`);
    continue;
  }
  const svg = await response.text();
  const match = svg.match(/ d="([^"]+)"/);
  if (!match) throw new Error(`no path in ${slug}`);
  lines.push(`  '${id}': { path: '${match[1]}' },`);
  console.log(`${id} (${slug}): ok`);
}

const banner = `/**
 * Official brand glyphs for catalog entries, paths from simple-icons (CC0).
 * Rendered monochrome on the muted surface tile; a brand glyph keeps its
 * recognizable shape without its marketing color. Entries absent here fall
 * back to the generic sprite icon.
 */

export type BrandIcon = {
  path: string;
};

const BRAND_ICONS = {
`;

fs.writeFileSync(TARGET, `${banner}${lines.join('\n')}\n} satisfies Record<string, BrandIcon>;\n
const BRAND_BY_ID = new Map(Object.entries(BRAND_ICONS));\n
/** The brand glyph for a catalog entry id, if the brand exists in simple-icons. */\n
export const brandIconFor = (id: string): BrandIcon | undefined => BRAND_BY_ID.get(id);\n`);
console.log(`written: ${lines.length} brands`);