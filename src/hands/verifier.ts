/**
 * hands/verifier.ts — Hand Contract V0: the deterministic receipt verifier.
 *
 * WHAT THIS IS: verify(receipt) -> {verified, reason}. NO LLM, NO network. If
 * a claim can't be independently checked by a fixed rule against the real
 * filesystem/git state, it is REJECTED — that is the entire point of a
 * deterministic verifier (a plausible-sounding narrative and a real receipt
 * must be told apart by evidence, not by how convincing the text reads).
 *
 * SECRET GUARD: any `ref` matching PROTECTED_PATH_RE (.env/secret/credential/
 * .pem/id_rsa/id_ed25519/id_ecdsa/.pfx/.p12/.jks/service-account, case
 * insensitive) is refused BEFORE any fs/git call touches it — the guard runs
 * first in every branch that would otherwise read `ref`, so a protected path
 * is never opened, only pattern-matched against its own name. For
 * 'command-output-match', the same guard also runs against the WHOLE
 * `command` string before execFileSync, so a command that merely CITES a
 * protected path (e.g. `git show HEAD:apps/api/.env`) is refused too, not
 * just an explicit `ref`.
 *
 * COMMAND ALLOWLIST: 'command-output-match' only ever runs a command whose
 * full string matches one of a fixed set of read-only prefixes (below). No
 * shell is invoked (execFileSync, not exec) — the command string is split on
 * whitespace and run as `argv[0]` + args directly, so there is no shell
 * metacharacter interpretation surface even for an allowlisted command.
 *
 * FAILURE BEHAVIOR: every fs/git/process failure is caught and turned into
 * `{verified: false, reason: <precise message>}` — this module NEVER throws.
 * That mirrors exec-graph/ledger.ts's "reads never throw" rule, extended to
 * verification: a verifier that can crash the caller on a missing file is a
 * verifier that can be used to hang/DoS the delegation-control layer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Receipt } from './contract.js';

export interface VerifyResult {
  verified: boolean;
  reason: string;
}

const PROTECTED_PATH_RE = /\.env|secret|credential|\.pem|id_rsa|id_ed25519|id_ecdsa|\.pfx|\.p12|\.jks|service-account/i;

/** Anchored prefixes — a command must START with one of these to run at all. */
const READONLY_COMMAND_ALLOWLIST: readonly RegExp[] = [
  /^node dist\/cli\.js graph verify\b/,
  /^node dist\/cli\.js graph status\b/,
  /^git log\b/,
  /^git show\b/,
  /^git status\b/,
  /^git rev-parse\b/,
  /^ls\b/,
  /^git cat-file\b/,
];

function isProtectedPath(ref: string): boolean {
  return PROTECTED_PATH_RE.test(ref);
}

function isAllowlistedCommand(command: string): boolean {
  const trimmed = command.trim();
  return READONLY_COMMAND_ALLOWLIST.some((re) => re.test(trimmed));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deterministic, no-LLM, no-network verification of one Receipt. Never
 * throws — every branch returns a {verified, reason} pair.
 */
export function verify(receipt: Receipt): VerifyResult {
  switch (receipt.kind) {
    case 'narrative':
      return { verified: false, reason: 'narrative-only receipt has no independently checkable evidence' };

    case 'file-exists': {
      if (!receipt.ref) return { verified: false, reason: 'file-exists receipt is missing ref' };
      if (isProtectedPath(receipt.ref)) return { verified: false, reason: 'cited artifact is a protected path' };
      try {
        return existsSync(receipt.ref)
          ? { verified: true, reason: `file exists: ${receipt.ref}` }
          : { verified: false, reason: `file does not exist: ${receipt.ref}` };
      } catch (err) {
        return { verified: false, reason: `file-exists check failed: ${describeError(err)}` };
      }
    }

    case 'commit-exists': {
      if (!receipt.ref) return { verified: false, reason: 'commit-exists receipt is missing ref' };
      if (isProtectedPath(receipt.ref)) return { verified: false, reason: 'cited artifact is a protected path' };
      try {
        const out = execFileSync('git', ['cat-file', '-t', receipt.ref], { encoding: 'utf8' }).trim();
        return out === 'commit'
          ? { verified: true, reason: `git object ${receipt.ref} is a commit` }
          : { verified: false, reason: `git object ${receipt.ref} is not a commit (type=${out || 'unknown'})` };
      } catch (err) {
        return { verified: false, reason: `commit-exists check failed: ${describeError(err)}` };
      }
    }

    case 'file-contains': {
      if (!receipt.ref) return { verified: false, reason: 'file-contains receipt is missing ref' };
      if (isProtectedPath(receipt.ref)) return { verified: false, reason: 'cited artifact is a protected path' };
      if (!receipt.expectedSubstring) return { verified: false, reason: 'file-contains receipt is missing expectedSubstring' };
      try {
        const contents = readFileSync(receipt.ref, 'utf8');
        return contents.includes(receipt.expectedSubstring)
          ? { verified: true, reason: `file ${receipt.ref} contains expected substring` }
          : { verified: false, reason: `file ${receipt.ref} does not contain expected substring` };
      } catch (err) {
        return { verified: false, reason: `file-contains check failed: ${describeError(err)}` };
      }
    }

    case 'command-output-match': {
      if (!receipt.command) return { verified: false, reason: 'command-output-match receipt is missing command' };
      // Guard the WHOLE command string against a protected-path reference (e.g.
      // `git show HEAD:apps/api/.env`) BEFORE execFileSync ever runs — the
      // `ref` field is optional/separate and was previously the only thing
      // checked here, leaving a command that merely CITES a protected path
      // unguarded.
      if (isProtectedPath(receipt.command)) return { verified: false, reason: 'command references a protected path' };
      if (receipt.ref && isProtectedPath(receipt.ref)) return { verified: false, reason: 'cited artifact is a protected path' };
      if (!isAllowlistedCommand(receipt.command)) {
        return { verified: false, reason: 'command not in read-only verifier allowlist' };
      }
      if (!receipt.expectedSubstring) {
        return { verified: false, reason: 'command-output-match receipt is missing expectedSubstring' };
      }
      try {
        const [cmd, ...args] = receipt.command.trim().split(/\s+/);
        const stdout = execFileSync(cmd, args, { encoding: 'utf8' });
        return stdout.includes(receipt.expectedSubstring)
          ? { verified: true, reason: `command output matched expected substring '${receipt.expectedSubstring}'` }
          : { verified: false, reason: `command output did not contain expected substring '${receipt.expectedSubstring}'` };
      } catch (err) {
        return { verified: false, reason: `command-output-match check failed: ${describeError(err)}` };
      }
    }

    default: {
      const _exhaustive: never = receipt.kind;
      return { verified: false, reason: `unknown receipt kind: ${String(_exhaustive)}` };
    }
  }
}
