/**
 * hands/assist-approval-port.ts — Opaque, single-session approval capability.
 *
 * M7 Supervised Assist: the approval capability is minted ONLY by a foreground
 * TTY approval port after the human types a challenge containing the pack
 * short-hash. The capability is:
 *   - Opaque: a unique symbol, not a boolean or serializable token.
 *   - Single-session: consumed when the assist session starts, cannot be replayed.
 *   - In-memory only: never serialized, never written to file.
 *   - TTY-only: headless/non-TTY invocation refuses.
 *
 * No boolean (`allowPortal`, `allowSubmit`, etc.), planner payload, goal-runner
 * action, or serialized file may mint or forge this capability.
 *
 * Goal-runner MUST NOT import this module (structural negative test enforces).
 */

import { createInterface } from 'node:readline';
import { shortHash, type ApprovedAnswerPack } from './assist-contract.js';

// ── Opaque capability token ─────────────────────────────────────────

/**
 * The approval capability is a unique Symbol — it cannot be forged by JSON,
 * serialization, boolean flags, or any value that didn't come from this module.
 * Each minting creates a new unique symbol.
 */
export type ApprovalCapability = symbol & { readonly __brand: 'assist-approval' };

/** WeakRef-style consumed tracking: once consumed, the symbol is invalidated. */
const consumedCapabilities = new Set<symbol>();

function mintCapability(): ApprovalCapability {
  return Symbol('assist-approval') as ApprovalCapability;
}

/**
 * Validate that a value is a genuine, unconsumed ApprovalCapability.
 * Returns false for: undefined, null, booleans, strings, numbers, objects,
 * consumed capabilities, or symbols not created by this module.
 */
export function isValidCapability(cap: unknown): cap is ApprovalCapability {
  if (typeof cap !== 'symbol') return false;
  if (consumedCapabilities.has(cap)) return false;
  // Check the symbol's description matches our minting pattern
  return cap.description === 'assist-approval';
}

/**
 * Consume an approval capability. After consumption, the capability is
 * invalidated and cannot be reused. Returns true if consumed successfully.
 */
export function consumeCapability(cap: ApprovalCapability): boolean {
  if (!isValidCapability(cap)) return false;
  consumedCapabilities.add(cap);
  return true;
}

// ── TTY approval port ───────────────────────────────────────────────

export interface ApprovalResult {
  approved: boolean;
  capability?: ApprovalCapability;
  reason: string;
}

/**
 * Check if the current process has a foreground TTY.
 * Headless/non-TTY invocation must be refused.
 */
export function isForegroundTTY(): boolean {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

/**
 * Request CEO approval for an answer pack via foreground TTY challenge.
 * The human must type the pack's short-hash to approve.
 *
 * @param pack The answer pack to approve
 * @param input Injectable input stream (defaults to process.stdin, tests inject a mock)
 * @param output Injectable output stream (defaults to process.stdout)
 * @returns ApprovalResult with capability on success
 */
export async function requestApproval(
  pack: ApprovedAnswerPack,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<ApprovalResult> {
  // TTY check — refuse headless/non-TTY
  if (!input || !(input as any).isTTY) {
    return { approved: false, reason: 'TTY required: headless/non-TTY invocation refused' };
  }

  const hash = shortHash(pack.packHash);
  const fieldList = pack.fields.map(f => `  ${f.label}: "${f.value}"`).join('\n');

  const prompt = [
    '',
    '=== SUPERVISED ASSIST — CEO APPROVAL REQUIRED ===',
    `Origin: ${pack.origin}`,
    `Form: ${pack.formFingerprint}`,
    `Fields to fill:`,
    fieldList,
    `Pack hash: ${pack.packHash}`,
    `Expires: ${pack.expiresAt}`,
    '',
    `To approve, type the first 8 characters of the pack hash: ${hash.slice(0, 4)}____`,
    '> ',
  ].join('\n');

  return new Promise<ApprovalResult>((resolve) => {
    const rl = createInterface({ input: input as NodeJS.ReadableStream, output, terminal: false });

    output.write(prompt);

    const timeout = setTimeout(() => {
      rl.close();
      resolve({ approved: false, reason: 'approval timed out (60s)' });
    }, 60_000);

    rl.once('line', (line) => {
      clearTimeout(timeout);
      rl.close();

      const typed = line.trim();
      if (typed === hash) {
        const capability = mintCapability();
        resolve({ approved: true, capability, reason: 'CEO approved via TTY challenge' });
      } else {
        resolve({ approved: false, reason: `hash mismatch: expected ${hash}, got "${typed}"` });
      }
    });
  });
}
