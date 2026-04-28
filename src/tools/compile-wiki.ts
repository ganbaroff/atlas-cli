import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = process.cwd();
const RAW_DIR = join(ROOT, 'memory', 'raw');
const CONCEPTS_DIR = join(ROOT, 'memory', 'concepts');

function toSlug(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildFrontmatter(data: Record<string, unknown>): string {
  const lines = Object.entries(data).map(([k, v]) =>
    Array.isArray(v)
      ? `${k}:\n${v.map((x: string) => `  - ${x}`).join('\n')}`
      : `${k}: ${v}`,
  );
  return `---\n${lines.join('\n')}\n---\n`;
}

export const compileWikiTool = createTool({
  id: 'compile-wiki',
  description:
    'Karpathy wiki-memory: read raw notes from memory/raw/, extract atomic concepts, build interlinked concept files in memory/concepts/ with [[wiki-link]] backlinks and frontmatter.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    new: z.number(),
    updated: z.number(),
    links_added: z.number(),
  }),
  execute: async () => {
    if (!existsSync(RAW_DIR)) return { new: 0, updated: 0, links_added: 0 };
    await mkdir(CONCEPTS_DIR, { recursive: true });

    const rawFiles = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.md'));
    let newCount = 0;
    let updatedCount = 0;
    let linksAdded = 0;

    for (const file of rawFiles) {
      const rawContent = await readFile(join(RAW_DIR, file), 'utf-8');
      const titleMatch = rawContent.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');
      const slug = toSlug(title);
      const filePath = join(CONCEPTS_DIR, `${slug}.md`);
      const today = new Date().toISOString().split('T')[0];

      if (existsSync(filePath)) {
        const existing = await readFile(filePath, 'utf-8');
        const sourceRef = `\n\nSource: [[${file}]]\n`;
        if (!existing.includes(`[[${file}]]`)) {
          await writeFile(filePath, existing.trimEnd() + sourceRef, 'utf-8');
          linksAdded++;
        }
        updatedCount++;
      } else {
        const fm = buildFrontmatter({
          title,
          date: today,
          'source-files': [file],
          'related-concepts': [],
        });
        const body = `${rawContent.trim()}\n\nSource: [[${file}]]\n`;
        await writeFile(filePath, fm + '\n' + body, 'utf-8');
        linksAdded++;
        newCount++;
      }
    }

    return { new: newCount, updated: updatedCount, links_added: linksAdded };
  },
});
