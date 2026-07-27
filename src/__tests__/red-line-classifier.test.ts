/**
 * Red-line classifier — additive free-tier LLM vote tests (P0.2 C2).
 *
 * All classifier calls are MOCKED — no live network in tests.
 * The classifier is strictly additive: it can block but never unblock
 * something the keyword floor already blocked.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  classifyCommandText,
  checkRedLineWithClassifier,
  type ClassifierDeps,
} from '../goal-runner/red-line.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Classifier deps that always returns 'allow'. */
function allowDeps(): ClassifierDeps {
  return {
    isEnabled: () => true,
    callLLM: vi.fn().mockResolvedValue('ALLOW'),
  };
}

/** Classifier deps that always returns 'block'. */
function blockDeps(): ClassifierDeps {
  return {
    isEnabled: () => true,
    callLLM: vi.fn().mockResolvedValue('BLOCK'),
  };
}

/** Classifier deps that throws (simulates transport error / timeout). */
function errorDeps(): ClassifierDeps {
  return {
    isEnabled: () => true,
    callLLM: vi.fn().mockRejectedValue(new Error('provider timeout')),
  };
}

/** Classifier deps with kill-switch active. */
function disabledDeps(): ClassifierDeps {
  return {
    isEnabled: () => false,
    callLLM: vi.fn().mockResolvedValue('ALLOW'),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Keywords block => classifier never called (spy assertion)
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance 1: keywords block => classifier never called', () => {
  it('keyword-blocked command does not invoke the classifier', async () => {
    const deps = blockDeps();
    // "delete all" is keyword-blocked
    const result = await checkRedLineWithClassifier('delete all files', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Keyword floor');
    expect(deps.callLLM).not.toHaveBeenCalled();
  });

  it('Russian keyword-blocked command does not invoke the classifier', async () => {
    const deps = blockDeps();
    const result = await checkRedLineWithClassifier('удалите все файлы', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Keyword floor');
    expect(deps.callLLM).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Keywords pass + classifier says block => refused with classifier reason
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance 2: keywords pass + classifier blocks', () => {
  it('benign-to-keywords command blocked by classifier includes classifier reason', async () => {
    const deps = blockDeps();
    // "check server status" passes keywords
    const kwResult = classifyCommandText('check server status');
    expect(kwResult.blocked).toBe(false); // precondition

    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Classifier');
    expect(deps.callLLM).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Keywords pass + classifier says allow => passes
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance 3: keywords pass + classifier allows', () => {
  it('benign command passes when both keyword floor and classifier agree', async () => {
    const deps = allowDeps();
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.blocked).toBe(false);
    expect(deps.callLLM).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Keywords pass + classifier throws/times out => refused with error reason
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance 4: keywords pass + classifier error => refused', () => {
  it('transport error from classifier results in refusal with error reason', async () => {
    const deps = errorDeps();
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Classifier error');
    expect(deps.callLLM).toHaveBeenCalledOnce();
  });

  it('unparseable classifier response results in refusal', async () => {
    const deps: ClassifierDeps = {
      isEnabled: () => true,
      callLLM: vi.fn().mockResolvedValue('maybe it is fine idk'),
    };
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Classifier error');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Kill-switch set => classifier never called, keyword-only behavior
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance 5: kill-switch disables classifier', () => {
  it('with kill-switch, benign command passes without calling classifier', async () => {
    const deps = disabledDeps();
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.blocked).toBe(false);
    expect(deps.callLLM).not.toHaveBeenCalled();
  });

  it('with kill-switch, keyword-blocked command still blocks', async () => {
    const deps = disabledDeps();
    const result = await checkRedLineWithClassifier('delete all files', deps);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Keyword floor');
    expect(deps.callLLM).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Reason strings are machine-distinguishable
// ═══════════════════════════════════════════════════════════════════════

describe('Reason string distinguishability', () => {
  it('keyword-block reason starts with "Keyword floor:"', async () => {
    const deps = allowDeps();
    const result = await checkRedLineWithClassifier('delete all files', deps);
    expect(result.reason).toMatch(/^Keyword floor:/);
  });

  it('classifier-block reason starts with "Classifier:"', async () => {
    const deps = blockDeps();
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.reason).toMatch(/^Classifier:/);
  });

  it('classifier-error reason starts with "Classifier error:"', async () => {
    const deps = errorDeps();
    const result = await checkRedLineWithClassifier('check server status', deps);
    expect(result.reason).toMatch(/^Classifier error:/);
  });
});
