import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const SRC_ROOT = resolve(TESTS_DIR, '..');
const SEAM_FILE = resolve(SRC_ROOT, 'atlas', 'shadow-rehearsal-test-seam.ts');
const ALLOWED_OUTSIDE_IMPORTER = resolve(SRC_ROOT, 'atlas', 'shadow-rehearsal.ts');
const ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS = [
  'resolveShadowRehearsalDependencies',
  'ShadowRehearsalDependencies',
];

const IMPORT_FROM_SEAM_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)*[^'"]*shadow-rehearsal-test-seam(?:\.js)?['"]/g;

function listTsFiles(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      listTsFiles(fullPath, output);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      output.push(fullPath);
    }
  }
  return output;
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_FROM_SEAM_RE.lastIndex = 0;

  while ((match = IMPORT_FROM_SEAM_RE.exec(source))) {
    for (const raw of match[1].split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) specifiers.push(name);
    }
  }
  return specifiers;
}

describe('atlas/shadow-rehearsal test seam import boundary', () => {
  it('allows only the fixed dependency getter outside the test tree', () => {
    expect(existsSync(SEAM_FILE)).toBe(true);

    const violations: string[] = [];
    let allowlistedImporterSeen = false;
    const sourceFiles = listTsFiles(SRC_ROOT).filter((file) => resolve(file) !== SEAM_FILE);

    for (const file of sourceFiles) {
      const resolvedFile = resolve(file);
      const specifiers = importedSpecifiers(readFileSync(resolvedFile, 'utf8'));
      if (specifiers.length === 0) continue;
      if (resolvedFile.startsWith(TESTS_DIR + sep)) continue;

      if (resolvedFile === ALLOWED_OUTSIDE_IMPORTER) {
        allowlistedImporterSeen = true;
        const disallowed = specifiers.filter(
          (specifier) => !ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS.includes(specifier),
        );
        if (disallowed.length > 0) {
          violations.push(
            `${relative(SRC_ROOT, resolvedFile)} imports disallowed seam export(s): ${disallowed.join(', ')}`,
          );
        }
        continue;
      }

      violations.push(
        `${relative(SRC_ROOT, resolvedFile)} imports the test seam outside src/__tests__/: ${specifiers.join(', ')}`,
      );
    }

    expect(violations).toEqual([]);
    expect(allowlistedImporterSeen).toBe(true);
  });
});
