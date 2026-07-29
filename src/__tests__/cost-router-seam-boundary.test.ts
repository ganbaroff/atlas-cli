import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical boundary check (M2C): today nothing stops production code from
 * importing `cost-router-test-seam.ts` directly and reaching
 * `withTrustedTables` — the only function that can substitute the trusted
 * availability/provider-class tables `runTrustedRoutedAttempt` resolves. The
 * module-graph argument in that file's own header ("a caller that imports
 * only cost-router-classify.ts has no path to withTrustedTables") is true
 * only as long as no OTHER file outside `src/__tests__/` adds that import.
 * This test makes that a checked invariant instead of a comment.
 */

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const SRC_ROOT = resolve(TESTS_DIR, '..');
const SEAM_FILE = resolve(SRC_ROOT, 'atlas', 'cost-router-test-seam.ts');

/**
 * `cost-router-classify.ts` legitimately imports `resolveTrustedTables` (the
 * read-only getter `runTrustedRoutedAttempt` calls on every invocation) from
 * the seam file — never `withTrustedTables` (the override installer). That
 * is the one known, reviewed outside importer. Any other file outside
 * `src/__tests__/` importing the seam, or this file importing
 * `withTrustedTables`, is a boundary violation this test must catch.
 */
const ALLOWED_OUTSIDE_IMPORTER = resolve(SRC_ROOT, 'atlas', 'cost-router-classify.ts');
const ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS = ['resolveTrustedTables'];

const IMPORT_FROM_SEAM_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)*[^'"]*cost-router-test-seam(?:\.js)?['"]/g;

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listTsFiles(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function seamSpecifiersImportedBy(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_FROM_SEAM_RE.lastIndex = 0;
  while ((match = IMPORT_FROM_SEAM_RE.exec(source))) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) specifiers.push(name);
    }
  }
  return specifiers;
}

describe('atlas/cost-router-test-seam import boundary', () => {
  it('is imported only from src/__tests__/, plus the one allowlisted getter-only importer', () => {
    const allFiles = listTsFiles(SRC_ROOT).filter((f) => resolve(f) !== SEAM_FILE);
    const violations: string[] = [];
    let allowlistedImporterSeen = false;

    for (const file of allFiles) {
      const resolvedFile = resolve(file);
      const source = readFileSync(resolvedFile, 'utf8');
      const specifiers = seamSpecifiersImportedBy(source);
      if (specifiers.length === 0) continue;

      const isInsideTests = resolvedFile.startsWith(TESTS_DIR + sep);
      if (isInsideTests) continue;

      if (resolvedFile === ALLOWED_OUTSIDE_IMPORTER) {
        allowlistedImporterSeen = true;
        const disallowed = specifiers.filter(
          (s) => !ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS.includes(s),
        );
        if (disallowed.length > 0) {
          violations.push(
            `${relative(SRC_ROOT, resolvedFile)} imports disallowed seam export(s): ${disallowed.join(', ')} (only ${ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS.join(', ')} is allowlisted)`,
          );
        }
        continue;
      }

      violations.push(
        `${relative(SRC_ROOT, resolvedFile)} imports the test seam from outside src/__tests__/: ${specifiers.join(', ')}`,
      );
    }

    expect(violations).toEqual([]);
    // Guards the allowlist itself against going stale (e.g. the import gets
    // removed or renamed and the entry silently stops meaning anything).
    expect(allowlistedImporterSeen).toBe(true);
  });
});
