/**
 * M3D Task 6 — physical cutover packet (non-executed against live paths).
 *
 * Generates a strict, hashed command packet for preflight / cutover / rollback.
 * Destructive steps require ATLAS_PHYSICAL_CUTOVER_EXECUTE=1 AND every mutation
 * path must resolve inside an explicit disposable sandboxRoot. Live roots are
 * never mutated by this module in Task 6.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';

export const PHYSICAL_CUTOVER_EXECUTE_TOKEN = 'ATLAS_PHYSICAL_CUTOVER_EXECUTE';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, 'path must be absolute');

export type CutoverPacketErrorCode =
  | 'path_invalid'
  | 'path_escape'
  | 'junction_unsafe'
  | 'token_missing'
  | 'sandbox_required'
  | 'anchor_invalid'
  | 'packet_invalid'
  | 'step_failed'
  | 'live_path_refused';

export class CutoverPacketError extends Error {
  constructor(
    readonly code: CutoverPacketErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CutoverPacketError';
  }
}

const fileAnchorSchema = z
  .object({
    kind: z.enum([
      'git-bundle',
      'working-data-zip',
      'uncommitted-patch',
      'staged-index-patch',
      'scheduler-xml',
      'railway-binding',
      'env-metadata',
      'free-space-receipt',
    ]),
    path: absolutePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const junctionEntrySchema = z
  .object({
    linkPath: absolutePathSchema,
    expectedTarget: absolutePathSchema,
    linkType: z.enum(['junction', 'symlink-dir']),
  })
  .strict();

const rootsSchema = z
  .object({
    anusCodeRoot: absolutePathSchema,
    legacyAtlasRoot: absolutePathSchema,
    finalAtlasRoot: absolutePathSchema,
    quarantineSibling: absolutePathSchema,
    stateRoot: absolutePathSchema,
  })
  .strict();

const envMetadataSchema = z
  .object({
    path: absolutePathSchema,
    present: z.boolean(),
    bytes: z.number().int().nonnegative().optional(),
    /** Never store secret values — owner/ACL are optional metadata only. */
    owner: z.string().min(1).optional(),
    aclDigest: sha256Schema.optional(),
  })
  .strict();

const railwayBindingSchema = z
  .object({
    path: absolutePathSchema,
    project: z.string().min(1),
    service: z.string().min(1),
    /** Redacted working-directory binding — absolute path only, no tokens. */
    workingDirectory: absolutePathSchema,
    sha256: sha256Schema,
  })
  .strict();

const schedulerSubstituteSchema = z
  .object({
    path: absolutePathSchema,
    taskName: z.string().min(1),
    workingDirectory: absolutePathSchema,
    command: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();

const cutoverStepSchema = z
  .object({
    id: z.string().min(1),
    phase: z.enum(['preflight', 'cutover', 'verify', 'rollback']),
    title: z.string().min(1),
    destructive: z.boolean(),
    requiresToken: z.boolean(),
    /** Absolute paths this step may mutate. Empty for read-only steps. */
    mutationPaths: z.array(absolutePathSchema),
  })
  .strict();

export const cutoverPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('atlas.m3d-physical-cutover-packet'),
    createdAt: z.string().datetime(),
    /** Disposable sandbox that must contain every mutation path. */
    sandboxRoot: absolutePathSchema,
    executeTokenName: z.literal(PHYSICAL_CUTOVER_EXECUTE_TOKEN),
    roots: rootsSchema,
    anchors: z.array(fileAnchorSchema).min(1),
    junctions: z.array(junctionEntrySchema),
    envMetadata: envMetadataSchema,
    railwayBinding: railwayBindingSchema,
    scheduler: schedulerSubstituteSchema,
    worktrees: z.array(absolutePathSchema),
    steps: z.array(cutoverStepSchema).min(1),
    rollbackSteps: z.array(cutoverStepSchema).min(1),
  })
  .strict();

export type CutoverPacket = z.infer<typeof cutoverPacketSchema>;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireAbsolute(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new CutoverPacketError('path_invalid', `${label} must be absolute`);
  }
  return resolve(path);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Lexical + realpath containment: candidate must be a strict child of root. */
export function assertPathContained(
  root: string,
  candidate: string,
  label = 'path',
): void {
  const resolvedRoot = requireAbsolute(root, 'root');
  const resolvedCandidate = requireAbsolute(candidate, label);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new CutoverPacketError(
      'path_escape',
      `${label} escapes sandbox root: ${resolvedCandidate}`,
    );
  }
  if (!pathEntryExists(resolvedRoot)) return;
  try {
    const realRoot = realpathSync.native(resolvedRoot);
    // If candidate does not exist yet, prove its parent chain stays inside.
    let probe = resolvedCandidate;
    while (!pathEntryExists(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (pathEntryExists(probe)) {
      const realProbe = realpathSync.native(probe);
      const realRel = relative(realRoot, realProbe);
      if (
        realRel.startsWith(`..${sep}`) ||
        realRel === '..' ||
        isAbsolute(realRel)
      ) {
        throw new CutoverPacketError(
          'path_escape',
          `${label} realpath escapes sandbox root: ${resolvedCandidate}`,
        );
      }
    }
  } catch (error) {
    if (error instanceof CutoverPacketError) throw error;
    throw new CutoverPacketError(
      'path_escape',
      `cannot prove containment for ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Junction/symlink must be a link whose realpath target equals expectedTarget
 * and both link + target stay inside the sandbox.
 */
export function assertJunctionRealpathSafe(
  linkPath: string,
  expectedTarget: string,
  sandboxRoot: string,
): void {
  const link = requireAbsolute(linkPath, 'linkPath');
  const expected = requireAbsolute(expectedTarget, 'expectedTarget');
  const sandbox = requireAbsolute(sandboxRoot, 'sandboxRoot');
  assertPathContained(sandbox, link, 'junction link');
  assertPathContained(sandbox, expected, 'junction target');
  if (!pathEntryExists(link)) {
    throw new CutoverPacketError('junction_unsafe', `junction missing: ${link}`);
  }
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    throw new CutoverPacketError(
      'junction_unsafe',
      `not a junction/symlink: ${link}`,
    );
  }
  let realTarget: string;
  try {
    realTarget = realpathSync.native(link);
  } catch (error) {
    throw new CutoverPacketError(
      'junction_unsafe',
      `cannot resolve junction realpath: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (resolve(realTarget) !== resolve(expected)) {
    throw new CutoverPacketError(
      'junction_unsafe',
      `junction target mismatch: expected ${expected}, got ${realTarget}`,
    );
  }
  assertPathContained(sandbox, realTarget, 'junction realpath');
}

function hashFile(path: string): { sha256: string; bytes: number } {
  const body = readFileSync(path);
  return { sha256: sha256(body), bytes: body.byteLength };
}

function writeAnchoredFile(path: string, body: string | Buffer): {
  path: string;
  sha256: string;
  bytes: number;
} {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { path, ...hashFile(path) };
}

export interface DisposableFixtureLayout {
  readonly sandboxRoot: string;
}

/**
 * Build a disposable fixture world under sandboxRoot and return a complete
 * cutover packet whose every mutation path is sandbox-contained.
 */
export function generateDisposableCutoverPacket(
  layout: DisposableFixtureLayout,
): CutoverPacket {
  const sandbox = requireAbsolute(layout.sandboxRoot, 'sandboxRoot');
  mkdirSync(sandbox, { recursive: true });

  const anusCodeRoot = join(sandbox, 'anus-code');
  const legacyAtlasRoot = join(sandbox, 'legacy-atlas');
  const finalAtlasRoot = join(sandbox, 'Projects', 'ATLAS');
  const quarantineSibling = join(sandbox, 'legacy-atlas.quarantine');
  const stateRoot = join(sandbox, 'state-root');
  const anchorsDir = join(sandbox, 'anchors');
  const junctionLink = join(sandbox, 'junctions', 'apps-cli');
  const junctionTarget = join(anusCodeRoot, 'apps', 'cli-target');
  const worktreePath = join(sandbox, 'worktrees', 'nested-clean');
  const envPath = join(anusCodeRoot, '.env');
  const schedulerPath = join(anchorsDir, 'AtlasRunner.xml');
  const railwayPath = join(anchorsDir, 'railway-binding.json');

  // Seed disposable topology.
  mkdirSync(join(anusCodeRoot, 'apps', 'cli-target'), { recursive: true });
  writeFileSync(join(anusCodeRoot, 'apps', 'cli-target', 'marker.txt'), 'cli\n');
  mkdirSync(legacyAtlasRoot, { recursive: true });
  writeFileSync(join(legacyAtlasRoot, 'README.md'), 'legacy\n');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, 'ok.txt'), 'worktree\n');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'placeholder.json'), '{}\n');
  writeFileSync(envPath, 'PLACEHOLDER=1\n'); // fixture only — not a real secret
  mkdirSync(dirname(junctionLink), { recursive: true });
  if (pathEntryExists(junctionLink)) rmSync(junctionLink, { force: true });
  symlinkSync(
    junctionTarget,
    junctionLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const bundle = writeAnchoredFile(
    join(anchorsDir, 'anus.bundle'),
    Buffer.from('fake-git-bundle'),
  );
  const zip = writeAnchoredFile(
    join(anchorsDir, 'legacy-data.zip'),
    Buffer.from('fake-zip'),
  );
  const patch = writeAnchoredFile(
    join(anchorsDir, 'uncommitted.patch'),
    'diff --git a/x b/x\n',
  );
  const staged = writeAnchoredFile(
    join(anchorsDir, 'm4-staged.patch'),
    'diff --git a/y b/y\n',
  );
  const freeSpace = writeAnchoredFile(
    join(anchorsDir, 'free-space.json'),
    `${JSON.stringify({ freeBytes: 1_000_000_000, sandbox }, null, 2)}\n`,
  );

  const schedulerBody = `<Task><Name>AtlasRunner</Name><WorkingDirectory>${anusCodeRoot}</WorkingDirectory><Command>node dist/cli.js runner start</Command></Task>\n`;
  const scheduler = writeAnchoredFile(schedulerPath, schedulerBody);
  const railwayBody = `${JSON.stringify(
    {
      project: 'atlas-fixture',
      service: 'telegram',
      workingDirectory: anusCodeRoot,
    },
    null,
    2,
  )}\n`;
  const railway = writeAnchoredFile(railwayPath, railwayBody);
  const envMeta = hashFile(envPath);

  const roots = {
    anusCodeRoot,
    legacyAtlasRoot,
    finalAtlasRoot,
    quarantineSibling,
    stateRoot,
  };

  const steps = buildCutoverSteps(
    roots,
    worktreePath,
    junctionLink,
    scheduler.path,
    railway.path,
  );
  const rollbackSteps = buildRollbackSteps(roots, worktreePath, junctionLink, junctionTarget);

  const packet: CutoverPacket = {
    schemaVersion: 1,
    kind: 'atlas.m3d-physical-cutover-packet',
    createdAt: new Date().toISOString(),
    sandboxRoot: sandbox,
    executeTokenName: PHYSICAL_CUTOVER_EXECUTE_TOKEN,
    roots,
    anchors: [
      { kind: 'git-bundle', ...bundle },
      { kind: 'working-data-zip', ...zip },
      { kind: 'uncommitted-patch', ...patch },
      { kind: 'staged-index-patch', ...staged },
      { kind: 'scheduler-xml', path: scheduler.path, sha256: scheduler.sha256, bytes: scheduler.bytes },
      { kind: 'railway-binding', path: railway.path, sha256: railway.sha256, bytes: railway.bytes },
      {
        kind: 'env-metadata',
        path: envPath,
        sha256: envMeta.sha256,
        bytes: envMeta.bytes,
      },
      { kind: 'free-space-receipt', ...freeSpace },
    ],
    junctions: [
      {
        linkPath: junctionLink,
        expectedTarget: junctionTarget,
        linkType: process.platform === 'win32' ? 'junction' : 'symlink-dir',
      },
    ],
    envMetadata: {
      path: envPath,
      present: true,
      bytes: envMeta.bytes,
      owner: 'fixture',
      aclDigest: sha256('fixture-acl'),
    },
    railwayBinding: {
      path: railway.path,
      project: 'atlas-fixture',
      service: 'telegram',
      workingDirectory: anusCodeRoot,
      sha256: railway.sha256,
    },
    scheduler: {
      path: scheduler.path,
      taskName: 'AtlasRunner',
      workingDirectory: anusCodeRoot,
      command: 'node dist/cli.js runner start',
      sha256: scheduler.sha256,
    },
    worktrees: [worktreePath],
    steps,
    rollbackSteps,
  };

  validateCutoverPacket(packet);
  return cutoverPacketSchema.parse(packet);
}

function buildCutoverSteps(
  roots: CutoverPacket['roots'],
  worktreePath: string,
  junctionLink: string,
  schedulerPath: string,
  railwayPath: string,
): CutoverPacket['steps'] {
  return [
    {
      id: 'preflight-anchors',
      phase: 'preflight',
      title: 'Re-hash anchors and prove sandbox containment',
      destructive: false,
      requiresToken: false,
      mutationPaths: [],
    },
    {
      id: 'stop-writers',
      phase: 'cutover',
      title: 'Record writer-stopped receipt inside sandbox',
      destructive: true,
      requiresToken: true,
      mutationPaths: [join(roots.stateRoot, 'writer-stopped.json')],
    },
    {
      id: 'retire-worktree',
      phase: 'cutover',
      title: 'Retire disposable nested worktree',
      destructive: true,
      requiresToken: true,
      mutationPaths: [worktreePath],
    },
    {
      id: 'detach-junction',
      phase: 'cutover',
      title: 'Detach junction without traversing target',
      destructive: true,
      requiresToken: true,
      mutationPaths: [junctionLink],
    },
    {
      id: 'quarantine-legacy',
      phase: 'cutover',
      title: 'Rename legacy atlas root to quarantine sibling',
      destructive: true,
      requiresToken: true,
      mutationPaths: [roots.legacyAtlasRoot, roots.quarantineSibling],
    },
    {
      id: 'move-code-root',
      phase: 'cutover',
      title: 'Move ANUS code root to final ATLAS path',
      destructive: true,
      requiresToken: true,
      mutationPaths: [roots.anusCodeRoot, roots.finalAtlasRoot],
    },
    {
      id: 'bind-scheduler',
      phase: 'cutover',
      title: 'Rewrite scheduler substitute working directory',
      destructive: true,
      requiresToken: true,
      mutationPaths: [schedulerPath],
    },
    {
      id: 'bind-railway',
      phase: 'cutover',
      title: 'Rewrite railway substitute working directory',
      destructive: true,
      requiresToken: true,
      mutationPaths: [railwayPath],
    },
    {
      id: 'post-verify',
      phase: 'verify',
      title: 'Verify final root exists and legacy is quarantined',
      destructive: false,
      requiresToken: false,
      mutationPaths: [],
    },
  ];
}

function buildRollbackSteps(
  roots: CutoverPacket['roots'],
  worktreePath: string,
  junctionLink: string,
  junctionTarget: string,
): CutoverPacket['rollbackSteps'] {
  return [
    {
      id: 'rollback-move-code',
      phase: 'rollback',
      title: 'Move code root back to ANUS location',
      destructive: true,
      requiresToken: true,
      mutationPaths: [roots.finalAtlasRoot, roots.anusCodeRoot],
    },
    {
      id: 'rollback-quarantine',
      phase: 'rollback',
      title: 'Restore legacy atlas root from quarantine',
      destructive: true,
      requiresToken: true,
      mutationPaths: [roots.quarantineSibling, roots.legacyAtlasRoot],
    },
    {
      id: 'rollback-junction',
      phase: 'rollback',
      title: 'Restore junction from recorded target',
      destructive: true,
      requiresToken: true,
      mutationPaths: [junctionLink, junctionTarget],
    },
    {
      id: 'rollback-worktree',
      phase: 'rollback',
      title: 'Recreate disposable worktree placeholder',
      destructive: true,
      requiresToken: true,
      mutationPaths: [worktreePath],
    },
  ];
}

export interface ValidateCutoverPacketOptions {
  /**
   * After cutover, junctions are detached by design. Rollback validation must
   * still prove planned link/target paths are sandbox-contained without
   * requiring the link to exist yet.
   */
  readonly junctionPresence?: 'required' | 'planned';
}

/** Validate schema + every mutation/anchor path is sandbox-contained. */
export function validateCutoverPacket(
  packet: CutoverPacket,
  options: ValidateCutoverPacketOptions = {},
): void {
  const parsed = cutoverPacketSchema.parse(packet);
  const sandbox = parsed.sandboxRoot;
  const junctionPresence = options.junctionPresence ?? 'required';
  assertPathContained(sandbox, parsed.roots.anusCodeRoot, 'anusCodeRoot');
  assertPathContained(sandbox, parsed.roots.legacyAtlasRoot, 'legacyAtlasRoot');
  assertPathContained(sandbox, parsed.roots.finalAtlasRoot, 'finalAtlasRoot');
  assertPathContained(sandbox, parsed.roots.quarantineSibling, 'quarantineSibling');
  assertPathContained(sandbox, parsed.roots.stateRoot, 'stateRoot');
  assertPathContained(sandbox, parsed.envMetadata.path, 'envMetadata.path');
  assertPathContained(sandbox, parsed.railwayBinding.path, 'railwayBinding.path');
  assertPathContained(sandbox, parsed.scheduler.path, 'scheduler.path');
  for (const anchor of parsed.anchors) {
    assertPathContained(sandbox, anchor.path, `anchor:${anchor.kind}`);
  }
  for (const wt of parsed.worktrees) {
    assertPathContained(sandbox, wt, 'worktree');
  }
  for (const junction of parsed.junctions) {
    if (junctionPresence === 'required') {
      assertJunctionRealpathSafe(
        junction.linkPath,
        junction.expectedTarget,
        sandbox,
      );
    } else {
      assertPathContained(sandbox, junction.linkPath, 'junction link');
      assertPathContained(sandbox, junction.expectedTarget, 'junction target');
    }
  }
  for (const step of [...parsed.steps, ...parsed.rollbackSteps]) {
    for (const mutation of step.mutationPaths) {
      assertPathContained(sandbox, mutation, `step:${step.id}`);
    }
    if (step.destructive && !step.requiresToken) {
      throw new CutoverPacketError(
        'packet_invalid',
        `destructive step ${step.id} must require the execute token`,
      );
    }
  }
}

function requireExecuteToken(): void {
  const value = (process.env[PHYSICAL_CUTOVER_EXECUTE_TOKEN] ?? '').trim();
  if (value !== '1') {
    throw new CutoverPacketError(
      'token_missing',
      `${PHYSICAL_CUTOVER_EXECUTE_TOKEN}=1 is required to run destructive cutover/rollback steps`,
    );
  }
}

function refuseLiveKnownRoots(packet: CutoverPacket): void {
  const banned = [
    resolve('C:/Users/user/OneDrive/Documents/GitHub/ANUS'),
    resolve('C:/Projects/ATLAS'),
    resolve('C:/Projects/VOLAURA'),
  ];
  const sandbox = resolve(packet.sandboxRoot);
  for (const ban of banned) {
    if (sandbox === ban || sandbox.startsWith(`${ban}${sep}`)) {
      throw new CutoverPacketError(
        'live_path_refused',
        `sandboxRoot must not be under live root ${ban}`,
      );
    }
  }
}

export interface ExecuteCutoverResult {
  readonly mode: 'cutover' | 'rollback';
  readonly completedStepIds: string[];
  readonly packetSha256: string;
}

function runCutoverSteps(packet: CutoverPacket): string[] {
  const completed: string[] = [];
  for (const step of packet.steps) {
    if (step.requiresToken) requireExecuteToken();
    switch (step.id) {
      case 'preflight-anchors':
        validateCutoverPacket(packet);
        break;
      case 'stop-writers': {
        const receipt = join(packet.roots.stateRoot, 'writer-stopped.json');
        assertPathContained(packet.sandboxRoot, receipt, 'writer-stopped');
        writeFileSync(
          receipt,
          `${JSON.stringify({ stoppedAt: new Date().toISOString() }, null, 2)}\n`,
        );
        break;
      }
      case 'retire-worktree':
        for (const wt of packet.worktrees) {
          if (pathEntryExists(wt)) rmSync(wt, { recursive: true, force: false });
        }
        break;
      case 'detach-junction':
        for (const junction of packet.junctions) {
          assertJunctionRealpathSafe(
            junction.linkPath,
            junction.expectedTarget,
            packet.sandboxRoot,
          );
          rmSync(junction.linkPath, { force: false });
        }
        break;
      case 'quarantine-legacy':
        if (!pathEntryExists(packet.roots.legacyAtlasRoot)) {
          throw new CutoverPacketError('step_failed', 'legacy atlas root missing');
        }
        if (pathEntryExists(packet.roots.quarantineSibling)) {
          throw new CutoverPacketError('step_failed', 'quarantine sibling exists');
        }
        renameSync(packet.roots.legacyAtlasRoot, packet.roots.quarantineSibling);
        break;
      case 'move-code-root':
        if (!pathEntryExists(packet.roots.anusCodeRoot)) {
          throw new CutoverPacketError('step_failed', 'anus code root missing');
        }
        mkdirSync(dirname(packet.roots.finalAtlasRoot), { recursive: true });
        if (pathEntryExists(packet.roots.finalAtlasRoot)) {
          throw new CutoverPacketError('step_failed', 'final atlas root exists');
        }
        renameSync(packet.roots.anusCodeRoot, packet.roots.finalAtlasRoot);
        break;
      case 'bind-scheduler': {
        const next = `<Task><Name>${packet.scheduler.taskName}</Name><WorkingDirectory>${packet.roots.finalAtlasRoot}</WorkingDirectory><Command>${packet.scheduler.command}</Command></Task>\n`;
        writeFileSync(packet.scheduler.path, next);
        break;
      }
      case 'bind-railway': {
        const next = `${JSON.stringify(
          {
            project: packet.railwayBinding.project,
            service: packet.railwayBinding.service,
            workingDirectory: packet.roots.finalAtlasRoot,
          },
          null,
          2,
        )}\n`;
        writeFileSync(packet.railwayBinding.path, next);
        break;
      }
      case 'post-verify':
        if (!pathEntryExists(packet.roots.finalAtlasRoot)) {
          throw new CutoverPacketError('step_failed', 'final root missing after cutover');
        }
        if (!pathEntryExists(packet.roots.quarantineSibling)) {
          throw new CutoverPacketError('step_failed', 'quarantine missing after cutover');
        }
        if (pathEntryExists(packet.roots.anusCodeRoot)) {
          throw new CutoverPacketError('step_failed', 'anus root still present');
        }
        if (pathEntryExists(packet.roots.legacyAtlasRoot)) {
          throw new CutoverPacketError('step_failed', 'legacy root still present');
        }
        break;
      default:
        throw new CutoverPacketError('step_failed', `unknown cutover step ${step.id}`);
    }
    completed.push(step.id);
  }
  return completed;
}

function runRollbackSteps(packet: CutoverPacket): string[] {
  const completed: string[] = [];
  for (const step of packet.rollbackSteps) {
    if (step.requiresToken) requireExecuteToken();
    switch (step.id) {
      case 'rollback-move-code':
        if (pathEntryExists(packet.roots.finalAtlasRoot)) {
          mkdirSync(dirname(packet.roots.anusCodeRoot), { recursive: true });
          renameSync(packet.roots.finalAtlasRoot, packet.roots.anusCodeRoot);
        }
        break;
      case 'rollback-quarantine':
        if (pathEntryExists(packet.roots.quarantineSibling)) {
          renameSync(packet.roots.quarantineSibling, packet.roots.legacyAtlasRoot);
        }
        break;
      case 'rollback-junction':
        for (const junction of packet.junctions) {
          if (!pathEntryExists(junction.linkPath)) {
            mkdirSync(dirname(junction.linkPath), { recursive: true });
            symlinkSync(
              junction.expectedTarget,
              junction.linkPath,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
          }
          assertJunctionRealpathSafe(
            junction.linkPath,
            junction.expectedTarget,
            packet.sandboxRoot,
          );
        }
        break;
      case 'rollback-worktree':
        for (const wt of packet.worktrees) {
          mkdirSync(wt, { recursive: true });
          writeFileSync(join(wt, 'ok.txt'), 'worktree-restored\n');
        }
        break;
      default:
        throw new CutoverPacketError('step_failed', `unknown rollback step ${step.id}`);
    }
    completed.push(step.id);
  }
  return completed;
}

/**
 * Execute cutover or rollback. Refuses without the execute token and refuses
 * sandboxes under known live roots.
 */
export function executeCutoverPacket(
  packetInput: CutoverPacket,
  mode: 'cutover' | 'rollback',
): ExecuteCutoverResult {
  const packet = cutoverPacketSchema.parse(packetInput);
  refuseLiveKnownRoots(packet);
  validateCutoverPacket(packet, {
    junctionPresence: mode === 'rollback' ? 'planned' : 'required',
  });
  if (!packet.sandboxRoot) {
    throw new CutoverPacketError('sandbox_required', 'sandboxRoot is required');
  }
  requireExecuteToken();

  const completedStepIds =
    mode === 'cutover' ? runCutoverSteps(packet) : runRollbackSteps(packet);

  return {
    mode,
    completedStepIds,
    packetSha256: sha256(JSON.stringify(packet)),
  };
}

/** Write packet JSON into the sandbox (documentation artifact only). */
export function writeCutoverPacketArtifact(
  packet: CutoverPacket,
  fileName = 'physical-cutover-packet.json',
): string {
  validateCutoverPacket(packet);
  const out = join(packet.sandboxRoot, fileName);
  assertPathContained(packet.sandboxRoot, out, 'packet artifact');
  writeFileSync(out, `${JSON.stringify(packet, null, 2)}\n`);
  return out;
}

/** Render a human-readable command file with destructive steps clearly gated. */
export function renderCutoverCommandFile(packet: CutoverPacket): string {
  validateCutoverPacket(packet);
  const lines: string[] = [
    '# Atlas M3D physical cutover command file',
    `# kind: ${packet.kind}`,
    `# sandboxRoot: ${packet.sandboxRoot}`,
    `# Destructive steps require: ${PHYSICAL_CUTOVER_EXECUTE_TOKEN}=1`,
    '# This file is non-authoritative documentation; executeCutoverPacket is the gate.',
    '',
    '## Preflight / cutover steps',
  ];
  for (const step of packet.steps) {
    lines.push(
      `- [${step.phase}] ${step.id}: ${step.title}` +
        (step.destructive
          ? ` [DESTRUCTIVE; token=${PHYSICAL_CUTOVER_EXECUTE_TOKEN}]`
          : ' [read-only]'),
    );
  }
  lines.push('', '## Rollback steps');
  for (const step of packet.rollbackSteps) {
    lines.push(
      `- [${step.phase}] ${step.id}: ${step.title}` +
        (step.destructive
          ? ` [DESTRUCTIVE; token=${PHYSICAL_CUTOVER_EXECUTE_TOKEN}]`
          : ' [read-only]'),
    );
  }
  lines.push('');
  return lines.join('\n');
}
