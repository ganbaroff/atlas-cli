/**
 * Minimal ambient types for js-yaml v3 (a production transitive dep via
 * @mastra/core → gray-matter, so present after `npm prune --omit=dev`).
 * We deliberately do NOT add @types/js-yaml as a devDependency: the lockfile is
 * currently in a --legacy-peer-deps state (zod peer conflict) and any
 * `npm install` re-resolves the whole tree. This decl covers the only two calls
 * policy.ts makes. See docs/POLICY.md → "YAML parser".
 */
declare module 'js-yaml' {
  export function load(input: string): unknown;
  export function dump(obj: unknown): string;
  const _default: { load: typeof load; dump: typeof dump };
  export default _default;
}
