#!/usr/bin/env node
/**
 * Atlas CLI — persistent AI agent, core of the VOLAURA ecosystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from 'commander';
import { createAtlasAgentWithRoute, recordAgentSpend, listAvailableModels } from './agent.js';
import { appendMessage, loadConversation } from './atlas/conversation-store.js';
import { IDENTITY } from './atlas/identity.js';
import { loadWakeContext, appendJournal, writeHeartbeat } from './atlas/memory-manager.js';
import { summarizeReplyGate } from './atlas/reply-gates.js';
import { deliverReply } from './atlas/reply-delivery.js';
import { extractTurnEvidence } from './atlas/turn-evidence.js';
import {
  applyControlCommand,
  controlAllowsModelCalls,
  describeControlBlock,
  parseControlCommand,
  type ControlSource,
} from './atlas/control-plane.js';
import { callPythonSwarm, isPythonSwarmAvailable, loadHiveProfiles } from './atlas/python-bridge.js';
import { runAndPersist, readLastReport, startCron } from './atlas/cron.js';
import { runHealthCheck, formatHealthReport } from './atlas/health-check.js';
import type { ModelRole } from './model-router.js';
import * as readline from 'node:readline';
import { capture, shutdown } from './analytics.js';
import {
  acquireInstanceLease,
  shouldAcquireInstanceLease,
  startInstanceLeaseHeartbeat,
} from './atlas/instance-lease.js';
import { writeSessionBreadcrumb, assertBreadcrumbBeforeExit } from './atlas/write-back-hook.js';

let ownedInstanceLeaseId: string | undefined;

// CWD-FIX: resolve .env from module dir, not process.cwd()
import { parse as dotenvParse } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ANUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(ANUS_ROOT, '.env');
if (existsSync(envPath)) {
  const parsed = dotenvParse(readFileSync(envPath, 'utf-8'));
  for (const [key, val] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = val;
  }
}

function printControlResult(message: string, control: unknown, validation?: unknown): void {
  console.log(JSON.stringify({
    message,
    control,
    validation: validation ?? null,
  }, null, 2));
}

function runControlCommand(
  command: string,
  lane: string | undefined,
  source: ControlSource,
): { message: string; control: unknown; validation?: unknown } {
  const normalized = parseControlCommand(
    `${command}${lane ? ` ${lane}` : ''}`,
  );
  if (!normalized) {
    return {
      message: 'Unknown control command.',
      control: null,
    };
  }

  const result = applyControlCommand(normalized, source);
  return {
    message: result.message,
    control: result.state.control ?? null,
    validation: result.validation,
  };
}

program
  .name('atlas')
  .description(`${IDENTITY.name} — ${IDENTITY.role}`)
  .version('0.1.0');

program
  .command('chat')
  .description('Interactive chat with Atlas')
  .option('-r, --role <role>', 'Model role: FAST, WORKER, JUDGE, CRITICAL', 'WORKER')
  .action(async (opts) => {
    const role = opts.role.toUpperCase() as ModelRole;
    const sessionStart = new Date();
    const turns: string[] = [];
    const CLI_CHAT_ID = 0;
    const MAX_HISTORY = 50;

    type ChatMessage = { role: 'user' | 'assistant'; content: string };
    const messages: ChatMessage[] = [];

    const restored = loadConversation(CLI_CHAT_ID, 20);
    for (const m of restored) {
      messages.push({ role: m.role, content: m.text });
    }
    if (restored.length > 0) console.log(`[memory] restored ${restored.length} messages from last session`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    capture('atlas_chat_started', { role });
    console.log(`\n${IDENTITY.name} здесь. Role: ${role}\n`);

    const closeSession = async () => {
      const sessionEnd = new Date();
      const duration = Math.round((sessionEnd.getTime() - sessionStart.getTime()) / 1000);
      const summary = [
        `## ${sessionEnd.toISOString().slice(0, 10)} · CLI session · ${role}`,
        '',
        `Start: ${sessionStart.toISOString()}  End: ${sessionEnd.toISOString()}  (${duration}s)`,
        `Turns: ${turns.length}`,
        turns.length > 0 ? `\nFirst prompt: ${turns[0]?.slice(0, 120)}` : '',
      ].join('\n');

      try {
        await appendJournal(summary);
        await writeHeartbeat({
          session: `CLI ${sessionStart.toISOString().slice(0, 16)} Baku`,
          role,
          turns: turns.length,
          duration_s: duration,
          last_updated: sessionEnd.toISOString(),
        });
      } catch {
        // vault write failed — silent, don't break exit
      }
      capture('atlas_chat_ended', { role, turns: turns.length, duration_s: duration });
      await shutdown();
      console.log('Я здесь.');
      rl.close();
    };

    const prompt = () => {
      rl.question('> ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === '/quit' || trimmed === '/exit') {
          await closeSession();
          return;
        }

        turns.push(trimmed);
        messages.push({ role: 'user', content: trimmed });
        if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY);

        appendMessage(CLI_CHAT_ID, { ts: new Date().toISOString(), role: 'user', text: trimmed })
          .catch(() => {});

        const controlCommand = parseControlCommand(trimmed);
        if (controlCommand) {
          const result = applyControlCommand(controlCommand, 'cli');
          messages.push({ role: 'assistant', content: result.message });
          appendMessage(CLI_CHAT_ID, { ts: new Date().toISOString(), role: 'assistant', text: result.message })
            .catch(() => {});
          printControlResult(result.message, result.state.control, result.validation);
          prompt();
          return;
        }

        if (!controlAllowsModelCalls()) {
          const blocked = describeControlBlock();
          messages.push({ role: 'assistant', content: blocked });
          appendMessage(CLI_CHAT_ID, { ts: new Date().toISOString(), role: 'assistant', text: blocked })
            .catch(() => {});
          console.log(`\n${blocked}\n`);
          prompt();
          return;
        }

        try {
          // Emotion source: recent user turns, newest-first (matches analyzeWindow contract).
          const recentUserMessages = messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .reverse()
            .slice(0, 8);
          const { agent, route } = await createAtlasAgentWithRoute(role, 'cli', recentUserMessages);
          const response = await agent.generate(messages);
          recordAgentSpend(response, route, 'cli');
          const delivery = await deliverReply(response.text, async (prompt) => {
            const retryResponse = await agent.generate([...messages, { role: 'user', content: prompt }]);
            recordAgentSpend(retryResponse, route, 'cli');
            return {
              reply: retryResponse.text,
              evidence: extractTurnEvidence(retryResponse),
            };
          }, extractTurnEvidence(response));
          if (delivery.repaired.retried) {
            console.warn(`[reply-gate] ${summarizeReplyGate(delivery.repaired.firstPass)} -> ${summarizeReplyGate(delivery.repaired.retryPass ?? delivery.repaired.firstPass)}`);
          }
          if (!delivery.emitDecision.emitOriginalReply) {
            console.warn(`[verify_completion_walk] ${delivery.emitDecision.reason ?? 'blocked'} proof=${delivery.emitDecision.proofTokens.length} matched=${delivery.emitDecision.matchedProofTokens.length}`);
          }
          const reply = delivery.reply;
          console.log(`\n${reply}\n`);
          messages.push({ role: 'assistant', content: reply });
          appendMessage(CLI_CHAT_ID, { ts: new Date().toISOString(), role: 'assistant', text: reply })
            .catch(() => {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${msg}\n`);
        }
        prompt();
      });
    };

    prompt();
  });

program
  .command('run <skill>')
  .description('Execute a VOLAURA skill by name (e.g. atlas run architecture-review)')
  .option('-r, --role <role>', 'Model role', 'WORKER')
  .option('-c, --context <context>', 'Additional context to pass to the skill')
  .action(async (skill: string, opts) => {
    const role = opts.role.toUpperCase() as ModelRole;
    if (!controlAllowsModelCalls()) {
      console.error(describeControlBlock());
      process.exit(2);
    }
    const { agent, route } = await createAtlasAgentWithRoute(role);

    const contextExtra = opts.context ? `\nAdditional context: ${opts.context}` : '';
    const prompt = `Load the skill "${skill}" using the load-skill tool and execute it against the current working directory (${process.cwd()}). Follow the skill spec precisely. Use your other tools (read-file, glob, grep, shell) as needed to gather the input data the skill requires.${contextExtra}`;

    capture('atlas_skill_run', { skill, role });
    console.log(`\n${IDENTITY.name} запускает скилл: ${skill}\n`);

    try {
      const response = await agent.generate(prompt);
      recordAgentSpend(response, route, 'cli');
      console.log(response.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    await shutdown();
  });

program
  .command('identity')
  .description('Show Atlas identity')
  .action(() => {
    console.log(JSON.stringify(IDENTITY, null, 2));
  });

program
  .command('control <command> [lane...]')
  .description('Update Atlas control state')
  .action((command: string, laneParts?: string[]) => {
    const result = runControlCommand(command, laneParts?.join(' '), 'cli');
    printControlResult(result.message, result.control, result.validation);
  });

program
  .command('models')
  .description('List available models (based on configured API keys)')
  .action(() => {
    const models = listAvailableModels();
    if (models.length === 0) {
      console.log('No models available. Set API keys in .env or environment.');
      return;
    }
    for (const m of models) {
      console.log(`  ${m.provider}/${m.modelId} [tier ${m.costTier}] → ${m.roles.join(', ')}`);
    }
  });

program
  .command('capture')
  .description('Capture the primary screen (READ-ONLY). --summarize adds an optional capped vision summary.')
  .option('-s, --summarize', 'Also produce a vision summary (opt-in, hourly-capped, free provider, secret-redacted)')
  .action(async (opts) => {
    try {
      const { runScreenCapture } = await import('./atlas/screen-capture.js');
      const { capture, summary } = await runScreenCapture({ summarize: !!opts.summarize });
      console.log(`[capture] ${capture.path}`);
      console.log(`[capture] ${capture.width}x${capture.height}, ${(capture.bytes / 1024).toFixed(0)} KB, ${capture.ts}`);
      if (capture.thumbPath) console.log(`[capture] thumb: ${capture.thumbPath}`);
      if (summary) {
        if (summary.skipped) console.log(`[summary] skipped: ${summary.reason}`);
        else console.log(`[summary] (${summary.provider}/${summary.model}, call ${summary.count}/hr): ${summary.summary}`);
      }
    } catch (err) {
      console.error(`capture error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('autonomy-tick')
  .description(
    'Run ONE tick of the local autonomy loop (READ-ONLY: repo_watch + health-check, which includes ' +
      'a file-based heartbeat-staleness check). Local-only V0 — not wired into Railway. ' +
      'See docs/AUTONOMY-RECOVERY-PLAN.md.',
  )
  .option('-n, --notify', 'Send a Telegram digest IF signals changed and the rate-limit allows')
  .action(async (opts) => {
    try {
      const { runTick } = await import('./atlas/autonomy-loop.js');
      const result = await runTick({ notify: !!opts.notify });
      console.log(`[autonomy-tick] ${result.ts} state=${result.state} — ${result.reason}`);
      if (result.signals) {
        console.log(result.signals.repoDigest);
        console.log(`Health: ${result.signals.health.summary}`);
      }
      if (result.state === 'notified') {
        console.log(`[autonomy-tick] sent=${result.sent} kind=${result.kind}`);
      }
      if (result.state === 'notify-failed') {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`autonomy-tick error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('autonomy-test-notify')
  .description(
    'Send ONE controlled, clearly-marked test notification through the canonical notify layer ' +
      '(rate-limited via a dedicated state file, separate from the real autonomy loop). ' +
      'V0.1 Blocker 3 verification tool — not part of normal operation.',
  )
  .action(async () => {
    try {
      const { sendControlledTestNotification } = await import('./atlas/autonomy-loop.js');
      const result = await sendControlledTestNotification();
      console.log(`[autonomy-test-notify] attempted=${result.attempted} — ${result.reason}`);
      if (result.outcomeResult) console.log(`[autonomy-test-notify] outcome=${result.outcomeResult}`);
      if (result.error) console.log(`[autonomy-test-notify] error=${result.error}`);
      // Mirrors autonomy-tick's exit-code contract: a genuine send FAILED must not
      // read as process-success at the automation boundary (adversarial review finding).
      if (result.outcomeResult === 'FAILED') {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`autonomy-test-notify error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('repo-watch')
  .description('Check configured git repos (READ-ONLY) and optionally notify CEO. No auto-commit/push/merge.')
  .option('-n, --notify', 'Send a Telegram digest IF something changed and the rate-limit allows')
  .action(async (opts) => {
    try {
      const { runRepoWatch } = await import('./atlas/repo-watch.js');
      const { digest, decision, sent } = await runRepoWatch({ notify: !!opts.notify });
      console.log(digest);
      console.log(`[repo-watch] notify=${decision.notify} (${decision.reason})${opts.notify ? ` sent=${sent}` : ''}`);
    } catch (err) {
      console.error(`repo-watch error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

const operatorCmd = program
  .command('operator')
  .description('Atlas operator integration controls');

operatorCmd
  .command('control <command> [lane...]')
  .description('Update operator control state')
  .action((command: string, laneParts?: string[]) => {
    const result = runControlCommand(command, laneParts?.join(' '), 'operator');
    printControlResult(result.message, result.control, result.validation);
  });

operatorCmd
  .command('status')
  .description('Show operator state and required artifacts')
  .action(async () => {
    const {
      ensureOperatorArtifacts,
      loadOperatorState,
      operatorStatePath,
    } = await import('./operator/dispatcher.js');

    const state = loadOperatorState();
    const artifacts = ensureOperatorArtifacts();
    console.log(JSON.stringify({
      state_path: operatorStatePath(),
      artifacts_found: artifacts.length,
      artifacts,
      state,
    }, null, 2));
  });

operatorCmd
  .command('validate <task>')
  .description('Validate an operator task contract')
  .action(async (taskPath: string) => {
    const { loadOperatorTask } = await import('./operator/dispatcher.js');
    try {
      const task = loadOperatorTask(taskPath);
      console.log(JSON.stringify({
        valid: true,
        id: task.id,
        route: task.route,
        mode: task.mode,
        expected_evidence: task.expected_evidence,
      }, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ valid: false, error: msg }, null, 2));
      process.exit(1);
    }
  });

operatorCmd
  .command('dispatch <task>')
  .description('Dispatch an operator task and write trace')
  .action(async (taskPath: string) => {
    const { dispatchOperatorTask, loadOperatorTask } = await import('./operator/dispatcher.js');
    try {
      const task = loadOperatorTask(taskPath);
      const result = dispatchOperatorTask(task);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'success' ? 0 : 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ status: 'failure', error: msg }, null, 2));
      process.exit(1);
    }
  });

operatorCmd
  .command('lifecycle <task>')
  .description('Run operator dispatch -> evaluate -> promote lifecycle')
  .action(async (taskRef: string) => {
    const { loadOperatorTaskRef, runOperatorLifecycle } = await import('./operator/lifecycle.js');
    try {
      const task = loadOperatorTaskRef(taskRef);
      const result = runOperatorLifecycle(task);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'success' && result.promotion?.promoted === true ? 0 : 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ status: 'failure', error: msg }, null, 2));
      process.exit(1);
    }
  });

operatorCmd
  .command('intake <intent...>')
  .description('Compile explicit user intent into operator task, run lifecycle, append ledger')
  .action(async (intentParts: string[]) => {
    const { runOperatorActionLane } = await import('./operator/action-lane.js');
    const outcome = runOperatorActionLane(intentParts.join(' '), { source: 'cli' });
    if (!outcome.handled) {
      console.error(JSON.stringify({
        handled: false,
        reason: 'No explicit operator action matched. Use: /operator smoke <url> [expected text], /operator local-smoke <url> [expected text], or /operator file-smoke <path> [expected text]',
      }, null, 2));
      process.exit(2);
    }

    console.log(JSON.stringify({
      handled: true,
      reply: outcome.reply,
      task_id: outcome.task?.id,
      result_task_id: outcome.result?.task_id,
      ledger: outcome.ledgerEntry ?? null,
      error: outcome.error ?? null,
    }, null, 2));
    process.exit(outcome.ledgerEntry?.verdict === 'passed' ? 0 : 2);
  });

// ─── exec-graph (EB-0) commands ────────────────────────────────────────────
// Single machine execution authority for new Atlas-managed work. See
// src/exec-graph/README.md for the authority boundary and full contract.

function collectRepeatable(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const goalCmd = program
  .command('goal')
  .description('exec-graph (EB-0) goal management');

goalCmd
  .command('run <objective...>')
  .description('Run a goal through the goal-runner: decompose → delegate → verify (bounded, autonomous)')
  .option('--hand <handId>', 'Hand to use for execution', 'browser-foreground')
  .option('--max-attempts <n>', 'Max attempts per task', '3')
  .option('--max-wall-time <ms>', 'Max wall time in milliseconds', '300000')
  .option('--resume <goalId>', 'Resume a previously started goal after process death')
  .action(async (objectiveParts: string[], opts) => {
    try {
      const { runGoal } = await import('./goal-runner/runner.js');
      const report = await runGoal({
        objective: objectiveParts.join(' '),
        handId: opts.hand,
        resumeGoalId: opts.resume,
        config: {
          maxAttemptsPerTask: parseInt(opts.maxAttempts, 10) || 3,
          maxWallTimeMs: parseInt(opts.maxWallTime, 10) || 300_000,
        },
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.status === 'completed' ? 0 : 2);
    } catch (err) {
      console.error(`goal run error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

goalCmd
  .command('add <title...>')
  .description('Create a new exec-graph goal')
  .option('--source-kind <kind>', 'Source kind', 'exec-graph')
  .option('--source-ref <ref>', 'Source ref', 'cli')
  .action(async (titleParts: string[], opts) => {
    try {
      const { createGoal } = await import('./exec-graph/api.js');
      const goal = createGoal({
        title: titleParts.join(' '),
        source: { kind: opts.sourceKind, ref: opts.sourceRef },
        actor: 'atlas',
      });
      console.log(JSON.stringify(goal, null, 2));
    } catch (err) {
      console.error(`goal add error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

const taskCmd = program
  .command('task')
  .description('exec-graph (EB-0) task management');

taskCmd
  .command('add <title...>')
  .description('Create a new exec-graph task under a goal')
  .requiredOption('--goal <id>', 'Goal id')
  .option('--risk <class>', 'Risk class: low|medium|high|irreversible', 'low')
  .option('--owner <owner>', 'Task owner', 'atlas')
  .option('--source-kind <kind>', 'Source kind', 'exec-graph')
  .option('--source-ref <ref>', 'Source ref', 'cli')
  .action(async (titleParts: string[], opts) => {
    try {
      const { createTask } = await import('./exec-graph/api.js');
      const { task, created } = createTask({
        goalId: opts.goal,
        title: titleParts.join(' '),
        riskClass: opts.risk,
        owner: opts.owner,
        source: { kind: opts.sourceKind, ref: opts.sourceRef },
        actor: 'atlas',
      });
      console.log(JSON.stringify({ created, task }, null, 2));
    } catch (err) {
      console.error(`task add error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

taskCmd
  .command('move <id> <status>')
  .description('Transition an exec-graph task to a new status')
  .requiredOption('--actor <actor>', 'Actor performing the transition (required)')
  .option('--evidence <ref>', 'Evidence ref (repeatable)', collectRepeatable, [] as string[])
  .option('--note <note>', 'Transition note')
  .action(async (id: string, status: string, opts) => {
    try {
      const { moveTask } = await import('./exec-graph/api.js');
      const task = moveTask({
        taskId: id,
        to: status as import('./exec-graph/contracts.js').TaskStatus,
        actor: opts.actor,
        evidenceRefs: opts.evidence && opts.evidence.length > 0 ? opts.evidence : undefined,
        note: opts.note,
      });
      console.log(JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(`task move error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

taskCmd
  .command('reassign <id> <newOwner>')
  .description('Reassign an exec-graph task to a new owner (append-only audit trail; does NOT change status)')
  .requiredOption('--actor <actor>', 'Actor performing the reassignment (required)')
  .requiredOption('--reason <reason>', 'Reason for the reassignment (required, quote if multi-word)')
  .action(async (id: string, newOwner: string, opts) => {
    try {
      const { reassignOwner } = await import('./exec-graph/api.js');
      const task = reassignOwner(id, newOwner, { actor: opts.actor, reason: opts.reason });
      console.log(JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(`task reassign error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

taskCmd
  .command('show <id>')
  .description('Show one exec-graph task')
  .action(async (id: string) => {
    const { getTask } = await import('./exec-graph/api.js');
    const task = getTask(id);
    if (!task) {
      console.error(`task not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(task, null, 2));
  });

taskCmd
  .command('list')
  .description('List exec-graph tasks, optionally filtered by status')
  .option('--status <status>', 'Filter by status')
  .action(async (opts) => {
    try {
      const { listTasks } = await import('./exec-graph/api.js');
      const tasks = listTasks(opts.status ? { status: opts.status } : {});
      console.log(JSON.stringify(tasks, null, 2));
    } catch (err) {
      console.error(`task list error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

taskCmd
  .command('import <title...>')
  .description('Import a task from a legacy source (idempotent by source kind+ref — see exec-graph/README.md)')
  .requiredOption('--goal <id>', 'Goal id')
  .requiredOption('--source-kind <kind>', 'Source kind (required)')
  .requiredOption('--source-ref <ref>', 'Source ref (required)')
  .option('--owner <owner>', 'Task owner', 'atlas')
  .option('--risk <class>', 'Risk class: low|medium|high|irreversible', 'low')
  .action(async (titleParts: string[], opts) => {
    try {
      const { importTask } = await import('./exec-graph/api.js');
      const { task, created } = importTask({
        goalId: opts.goal,
        title: titleParts.join(' '),
        sourceKind: opts.sourceKind,
        sourceRef: opts.sourceRef,
        owner: opts.owner,
        riskClass: opts.risk,
        actor: 'atlas',
      });
      console.log(JSON.stringify({ created, task }, null, 2));
    } catch (err) {
      console.error(`task import error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

const graphCmd = program
  .command('graph')
  .description('exec-graph (EB-0) ledger status/verify');

graphCmd
  .command('status')
  .description('Show status summary: counts per status + tasks waiting on decision/verification')
  .action(async () => {
    try {
      const { statusSummary } = await import('./exec-graph/api.js');
      const { CEO_DECISION_OWNERS } = await import('./exec-graph/brief.js');
      const summary = statusSummary();
      console.log('Exec-graph status:');
      for (const [status, count] of Object.entries(summary.counts)) {
        if (count > 0) console.log(`  ${status}: ${count}`);
      }

      // Escalated tasks reassigned (exec-graph/api.ts's reassignOwner()) to an
      // owner outside CEO_DECISION_OWNERS are still status=escalated but are
      // no longer a live decision item — split them into their own bucket so
      // a handed-off task doesn't keep re-appearing as "waiting on decision"
      // (same rule exec-graph/brief.ts applies to /status and the morning
      // brief, CLI-native text per this command's documented formatting).
      const decisionWaiting = summary.waiting.filter(
        (t) => t.status !== 'escalated' || CEO_DECISION_OWNERS.includes(t.owner),
      );
      const handedOff = summary.waiting.filter(
        (t) => t.status === 'escalated' && !CEO_DECISION_OWNERS.includes(t.owner),
      );

      if (decisionWaiting.length > 0) {
        console.log(`\nWaiting on decision/verification (${decisionWaiting.length}):`);
        for (const t of decisionWaiting) {
          console.log(`  [${t.status}] ${t.id} — ${t.title} (owner: ${t.owner})`);
        }
      } else {
        console.log('\nNothing waiting on decision/verification.');
      }

      if (handedOff.length > 0) {
        console.log(`\nHanded off — not a decision item (${handedOff.length}):`);
        for (const t of handedOff) {
          console.log(`  [${t.status}] ${t.id} — ${t.title} (owner: ${t.owner})`);
        }
      }
    } catch (err) {
      console.error(`graph status error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

graphCmd
  .command('verify')
  .description('Rebuild the snapshot from the ledger and compare it to the on-disk snapshot')
  .action(async () => {
    try {
      const { readSnapshotFile, rebuildSnapshot, snapshotsEqual } = await import('./exec-graph/ledger.js');
      const onDisk = readSnapshotFile() ?? { goals: {}, tasks: {} };
      const rebuilt = rebuildSnapshot();
      const ok = snapshotsEqual(onDisk, rebuilt);
      console.log(JSON.stringify({
        ok,
        onDiskGoals: Object.keys(onDisk.goals).length,
        onDiskTasks: Object.keys(onDisk.tasks).length,
        rebuiltGoals: Object.keys(rebuilt.goals).length,
        rebuiltTasks: Object.keys(rebuilt.tasks).length,
      }, null, 2));
      if (!ok) {
        console.error('[graph verify] MISMATCH: on-disk snapshot does not match a fresh rebuild from the ledger.');
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`graph verify error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ─── hands (Hand Contract V0) commands ─────────────────────────────────────
// Delegation-control layer OVER exec-graph — see src/hands/exec-graph-adapter.ts
// for the authority boundary. exec-graph stays the only task authority; the
// Hand registry (src/hands/registry.ts) is descriptive config only.

const handCmd = program
  .command('hand')
  .description('Hand Contract V0 — delegation-control layer over exec-graph');

handCmd
  .command('list')
  .description('List registered Hands (descriptive config, not task state)')
  .action(async () => {
    try {
      const { listHands } = await import('./hands/registry.js');
      console.log(JSON.stringify(listHands(), null, 2));
    } catch (err) {
      console.error(`hand list error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

handCmd
  .command('assign <taskId> <handId>')
  .description('Assign a Hand to an exec-graph task (moves task -> delegated, reassigns owner -> hand:<handId>)')
  .requiredOption('--actor <actor>', 'Actor performing the assignment (required)')
  .option('--unattended', 'Assign in an unattended context (denies foreground-only hands)')
  .action(async (taskId: string, handId: string, opts) => {
    try {
      const { assignHand } = await import('./hands/exec-graph-adapter.js');
      const task = assignHand(taskId, handId, { actor: opts.actor, unattended: !!opts.unattended });
      console.log(JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(`hand assign error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

handCmd
  .command('submit <taskId>')
  .description('Submit a receipt for a delegated task (moves task -> evidence-submitted; never sets verified/rejected)')
  .requiredOption('--by <hand>', 'Hand id submitting the receipt (required)')
  .requiredOption('--kind <kind>', 'Receipt kind: file-exists|commit-exists|file-contains|command-output-match|narrative (required)')
  .option('--ref <ref>', 'Artifact ref (file path / commit sha)')
  .option('--command <command>', 'Command cited as evidence (must be in the verifier read-only allowlist)')
  .option('--expect <substring>', 'Expected substring in file/command output')
  .option('--claim <text>', 'Claimed result narrative (required by the receipt schema)')
  .action(async (taskId: string, opts) => {
    try {
      const { submitReceipt } = await import('./hands/exec-graph-adapter.js');
      const task = submitReceipt(taskId, {
        taskId,
        handId: opts.by,
        submittedBy: opts.by,
        kind: opts.kind,
        ref: opts.ref,
        command: opts.command,
        expectedSubstring: opts.expect,
        claimedResult: opts.claim ?? '',
      });
      console.log(JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(`hand submit error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

handCmd
  .command('verify <taskId>')
  .description('Run the deterministic verifier (+ refuter when risk warrants) and set the task to verified/rejected')
  .requiredOption('--actor <actor>', 'Actor performing the verification (required)')
  .action(async (taskId: string, opts) => {
    try {
      const { verifyAndTransition } = await import('./hands/exec-graph-adapter.js');
      const result = verifyAndTransition(taskId, { actor: opts.actor });
      console.log(JSON.stringify(result, null, 2));
      if (!result.verdict.verified) process.exitCode = 1;
    } catch (err) {
      console.error(`hand verify error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ─── Chief-of-Staff (CoS) surface ───────────────────────────────────────────
// Read-only projection over exec-graph + control-plane + spend + git/
// heartbeat — NOT an authority, writes nothing (see src/atlas/cos/{facts,
// drift,brief,gather}.ts + docs/atlas-cto/SPRINT-CHIEF-OF-STAFF-V1.md).

const cosCmd = program
  .command('cos')
  .description('Chief-of-Staff surface — read-only brief/drift projection (writes nothing)');

cosCmd
  .command('brief')
  .description('Compose the six-category CEO brief from the live graph + drift signals')
  .option('--json', 'Output structured items instead of the Russian voice text')
  .action(async (opts) => {
    try {
      const { gatherCosFacts } = await import('./atlas/cos/facts.js');
      const { detectDrift } = await import('./atlas/cos/drift.js');
      const { composeCosBrief } = await import('./atlas/cos/brief.js');
      const { gatherLiveDriftInputs } = await import('./atlas/cos/gather.js');

      const facts = gatherCosFacts();
      const drift = detectDrift(gatherLiveDriftInputs());
      const brief = composeCosBrief(facts, drift);

      console.log(opts.json ? JSON.stringify(brief, null, 2) : brief.text);
    } catch (err) {
      console.error(`cos brief error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

cosCmd
  .command('drift')
  .description('Show drift/stale-signal findings only (git ahead, heartbeat stale, graph-verify, stuck tasks)')
  .action(async () => {
    try {
      const { detectDrift } = await import('./atlas/cos/drift.js');
      const { gatherLiveDriftInputs } = await import('./atlas/cos/gather.js');

      const findings = detectDrift(gatherLiveDriftInputs());
      console.log(findings.length === 0 ? 'No drift detected.' : JSON.stringify(findings, null, 2));
    } catch (err) {
      console.error(`cos drift error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// ─── swarm-exec (operator CLI surface) ─────────────────────────────────────
// Compile freeform intent -> draft -> exec-graph task -> delegated swarm run,
// verified through the same deterministic Hand Contract verifier as every
// other Hand (see src/swarm-exec/commands.ts). Named 'swarm-exec' rather
// than 'swarm' to avoid colliding with the pre-existing top-level
// `atlas swarm <task>` command below (src/swarm.ts's ad-hoc parallel-worker
// runner) — commander throws on a duplicate top-level command name.

const swarmExecCmd = program
  .command('swarm-exec')
  .description('swarm-exec: honest swarm runs verified through exec-graph');

swarmExecCmd
  .command('intake <intent...>')
  .description('Compile freeform intent into a swarm-exec draft (does NOT create a task)')
  .action(async (intentParts: string[]) => {
    try {
      const { intakeCommand } = await import('./swarm-exec/commands.js');
      const result = intakeCommand(intentParts.join(' '));
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nnext: atlas swarm-exec commit ${result.draftId}`);
    } catch (err) {
      console.error(`swarm-exec intake error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

swarmExecCmd
  .command('commit <draftId>')
  .description('Commit a swarm-exec draft into an exec-graph task')
  .option('--goal <goalId>', 'existing goal id (else a new goal is created)')
  .option('--actor <actor>')
  .action(async (draftId: string, opts) => {
    try {
      const { commitCommand } = await import('./swarm-exec/commands.js');
      const result = commitCommand(draftId, { goalId: opts.goal, actor: opts.actor });
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nnext: atlas swarm-exec run ${result.taskId}`);
    } catch (err) {
      console.error(`swarm-exec commit error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

swarmExecCmd
  .command('run <taskId>')
  .description('Assign swarm-local + run the swarm, verify through the deterministic verifier')
  .option('--actor <actor>')
  .action(async (taskId: string, opts) => {
    try {
      const { runCommand } = await import('./swarm-exec/commands.js');
      const result = await runCommand(taskId, { actor: opts.actor });
      console.log(JSON.stringify(result, null, 2));
      // An honest rejection/block is still a successful CLI invocation — exit 0,
      // just make the status impossible to miss.
      if (result.status !== 'verified') {
        console.error(`swarm-exec run: ${result.status} — ${result.reason}`);
      }
    } catch (err) {
      console.error(`swarm-exec run error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    // The verdict + bundle + graph transition are already persisted above; abandoned
    // provider sockets from timed-out workers can otherwise keep the event loop alive
    // for minutes. Force a clean exit once output is flushed.
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    process.exit(process.exitCode ?? 0);
  });

program
  .command('skills')
  .description('List available VOLAURA skills')
  .action(async () => {
    if (!controlAllowsModelCalls()) {
      console.error(describeControlBlock());
      process.exit(2);
    }
    try {
      const { agent, route } = await createAtlasAgentWithRoute('FAST');
      const res = await agent.generate(
        'List all available skills. Use the list-skills tool. Output just the names, one per line.',
      );
      recordAgentSpend(res, route, 'cli');
      console.log(res.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exitCode = 1;
    }
  });

program
  .command('swarm <task>')
  .description('Decompose task into parallel agent workers across providers')
  .action(async (task: string) => {
    if (!controlAllowsModelCalls()) {
      console.error(describeControlBlock());
      process.exit(2);
    }
    const { runResearchSwarm } = await import('./swarm.js');
    capture('atlas_swarm_run', { type: 'ts' });
    console.log(`\n${IDENTITY.name} запускает swarm\n`);
    try {
      const result = await runResearchSwarm(task);
      console.log(`\n[swarm] status=${result.artifact.status} exitReason=${result.artifact.exitReason}`);
      console.log('\n' + result.synthesis);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Swarm failed: ${msg}`);
      process.exit(1);
    }
    writeSessionBreadcrumb(`swarm:${task.slice(0, 80)}`);
    await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(process.exitCode ?? 0);
  });

program
  .command('swarm-eval')
  .description('A/B eval: baseline vs research swarm on deterministic fixture')
  .requiredOption('-f, --fixture <id>', 'Fixture id (evidence-gate-audit, schema-review)')
  .option('--dry-run', 'Report fixture metadata only — no live LLM calls')
  .action(async (opts) => {
    try {
      const { getFixture, buildEvalReport, fixtureFingerprint } = await import('./research-swarm/eval-harness.js');
      const fixture = getFixture(opts.fixture);
      if (!fixture) {
        console.error(`Unknown fixture: ${opts.fixture}`);
        process.exit(1);
      }
      if (opts.dryRun) {
        console.log(JSON.stringify({
          fixtureId: fixture.id,
          fingerprint: fixtureFingerprint(fixture),
          minProviders: fixture.minProvidersForResearch,
          verdict: 'KEEP_DISABLED',
          rationale: 'dry-run — no live calls',
        }, null, 2));
        await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 3000))]);
        process.exit(0);
      }
      if (!controlAllowsModelCalls()) {
        console.error(describeControlBlock());
        process.exit(2);
      }
      const { runResearchSwarm } = await import('./swarm.js');
      const t0 = Date.now();
      const swarmResult = await runResearchSwarm(fixture.task);
      const report = buildEvalReport({
        fixtureId: fixture.id,
        baselineMs: 0,
        swarmMs: Date.now() - t0,
        swarmStatus: swarmResult.artifact.status,
        providerCount: swarmResult.artifact.diversity.providerCount,
        minProviders: fixture.minProvidersForResearch,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.verdict === 'KEEP_DISABLED') process.exitCode = 1;
      await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 3000))]);
      process.exit(process.exitCode ?? 0);
    } catch (err) {
      console.error(`swarm-eval error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('swarm-deep <task>')
  .description('Route task to VOLAURA Python swarm (fail-closed — no silent fallback)')
  .option('-m, --mode <mode>', 'Swarm mode: coordinator, daily-ideation, code-review', 'coordinator')
  .action(async (task: string, opts) => {
    try {
      if (!controlAllowsModelCalls()) {
        console.error(describeControlBlock());
        process.exit(2);
      }
      capture('atlas_swarm_run', { type: 'python', mode: opts.mode });

      if (!isPythonSwarmAvailable()) {
        console.error('[bridge] EXPERIMENTAL_BRIDGE_DISABLED — Python swarm not found');
        console.error('[bridge] Use `atlas swarm` for TypeScript research-swarm instead');
        process.exit(1);
      }

      console.log(`\n${IDENTITY.name} вызывает Python swarm (mode: ${opts.mode})\n`);
      const result = await callPythonSwarm(task, opts.mode);
      console.log(`[bridge] status=${result.bridgeStatus} source=${result.source}`);

      if (result.success) {
        console.log(`[bridge] ${result.proposals.length} proposals (runId=${result.runId ?? '?'})`);
        for (const p of result.proposals.slice(0, 5)) {
          const prop = p as Record<string, unknown>;
          console.log(`  [${prop['severity'] ?? '?'}] ${String(prop['title'] ?? prop['summary'] ?? '').slice(0, 80)}`);
        }
      } else {
        console.error(`[bridge] failed: ${result.error}`);
        console.error('[bridge] No silent fallback — use `atlas swarm` for TypeScript research-swarm');
        process.exit(1);
      }
      await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 3000))]);
      process.exit(process.exitCode ?? 0);
    } catch (err) {
      console.error(`swarm-deep error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('hive')
  .description('Show Python hive agent profiles (competency, weights, status)')
  .action(async () => {
    const profiles = await loadHiveProfiles();
    if (profiles.length === 0) {
      console.log('No hive profiles found at ~/.swarm/hive/profiles/');
      return;
    }
    console.log(`\n${profiles.length} agent profiles:\n`);
    for (const p of profiles) {
      const name = String(p['model'] ?? p['name'] ?? '?').slice(0, 30);
      const status = p['status'] ?? '?';
      const accuracy = p['accuracy'] ?? p['overall_accuracy'] ?? '?';
      console.log(`  ${name} | status: ${status} | accuracy: ${accuracy}`);
    }
  });

program
  .command('telegram')
  .description('Start Atlas as Telegram bot (requires TELEGRAM_BOT_TOKEN in .env)')
  .action(async () => {
    await import('./telegram.js');
  });

program
  .command('ping')
  .description('Quick health check')
  .action(async () => {
    if (!controlAllowsModelCalls()) {
      console.error(describeControlBlock());
      process.exit(2);
    }
    try {
      const { agent, route } = await createAtlasAgentWithRoute('FAST');
      const response = await agent.generate('respond with exactly: Атлас здесь.');
      recordAgentSpend(response, route, 'cli');
      console.log(response.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Offline: ${msg}`);
      process.exit(1);
    }
  });

// ─── Wake command ─────────────────────────────────────────────────────────────

program
  .command('wake')
  .description('Atlas wake protocol — recall identity, memory, relationships, status')
  .option('-q, --quiet', 'Minimal output — just name + state + last session')
  .action(async (opts) => {
    const startMs = Date.now();

    // 1. Identity (always available — fallback inline)
    console.log(`\nАтлас здесь.\n`);
    console.log(`Name: ${IDENTITY.name}`);
    console.log(`Role: ${IDENTITY.role}`);
    console.log(`Voice: ${IDENTITY.voice_style}`);
    console.log(`Products: ${IDENTITY.ecosystem_products.join(', ')}`);

    // 2. Memory vault read
    try {
      const wakeCtx = await loadWakeContext();
      const vaultOk = !wakeCtx.includes('[missing:');

      // Heartbeat — last session
      const hbMatch = wakeCtx.match(/### heartbeat\.md[\s\S]*?(?=###|$)/);
      if (hbMatch) {
        const hbBody = hbMatch[0].replace(/### heartbeat\.md[^\n]*\n?/, '').trim();
        console.log('\n--- Last Session ---');
        // Extract key-value pairs from heartbeat
        const kvLines = hbBody.split('\n').filter((line: string) => line.startsWith('**') || line.startsWith('Updated:'));
        for (const line of kvLines.slice(0, 8)) {
          console.log(`  ${line.replace(/\*\*/g, '')}`);
        }
      }

      if (!opts.quiet) {
        // Relationships summary
        const relMatch = wakeCtx.match(/### relationships\.md[\s\S]*?(?=###|$)/);
        if (relMatch && !relMatch[0].includes('[missing:')) {
          const relBody = relMatch[0].replace(/### relationships\.md[^\n]*\n?/, '').trim();
          // Just first 3 non-empty lines
          const relLines = relBody.split('\n').filter((line: string) => line.trim()).slice(0, 3);
          if (relLines.length > 0) {
            console.log('\n--- Relationships ---');
            for (const l of relLines) console.log(`  ${l.trim().slice(0, 100)}`);
          }
        }

        // Lessons summary — just the recurring mistake classes header
        const lessonsMatch = wakeCtx.match(/### lessons\.md[\s\S]*?(?=###|$)/);
        if (lessonsMatch && !lessonsMatch[0].includes('[missing:')) {
          const lessonsBody = lessonsMatch[0].replace(/### lessons\.md[^\n]*\n?/, '').trim();
          // Count error classes
          const classCount = (lessonsBody.match(/^###?\s+/gm) ?? []).length;
          console.log(`\n--- Lessons: ${classCount} error classes loaded ---`);
        }

        // Debts summary
        const debtMatch = wakeCtx.match(/### atlas-debts-to-ceo\.md[\s\S]*?(?=###|$)/);
        if (debtMatch && !debtMatch[0].includes('[missing:')) {
          console.log('\n--- Debts: loaded ---');
        }

        // Journal — last 3 entries (truncated)
        const jMatch = wakeCtx.match(/### journal\.md[\s\S]*$/);
        if (jMatch) {
          const journalText = jMatch[0].replace(/### journal\.md[^\n]*\n?/, '').trim();
          console.log('\n--- Recent Journal ---');
          // Show first entry header lines
          const entryHeaders = journalText.split('\n')
            .filter((line: string) => line.startsWith('##') || line.match(/^\d{4}-\d{2}-\d{2}/))
            .slice(0, 5);
          for (const h of entryHeaders) console.log(`  ${h.trim().slice(0, 100)}`);
          if (entryHeaders.length === 0) {
            console.log(`  ${journalText.slice(0, 200)}`);
          }
        }
      }

      const elapsed = Date.now() - startMs;
      const vaultStatus = vaultOk ? 'vault connected' : 'vault partial';
      console.log(`\n[wake] ${vaultStatus}, ${elapsed}ms`);
    } catch {
      console.log('\n[memory vault unreachable — identity-only mode]');
    }

    console.log(`\nГотов к работе.`);
  });

// ─── Boot command ─────────────────────────────────────────────────────────────

program
  .command('boot')
  .description('Jarvis-like boot — load identity, health, last session, print status')
  .action(async () => {
    console.log(`\n${IDENTITY.name} загружается...\n`);

    // Health check
    const health = runHealthCheck();
    console.log(formatHealthReport(health));

    // Wake context summary (just heartbeat + last journal)
    try {
      const wakeCtx = await loadWakeContext();
      // Extract just heartbeat section
      const hbMatch = wakeCtx.match(/### heartbeat\.md[\s\S]*?(?=###|$)/);
      if (hbMatch) {
        console.log('\n--- Last Session ---');
        console.log(hbMatch[0].replace('### heartbeat.md — last session state', '').trim());
      }

      // Extract last journal
      const jMatch = wakeCtx.match(/### journal\.md[\s\S]*$/);
      if (jMatch) {
        console.log('\n--- Recent Journal ---');
        const journalText = jMatch[0].replace('### journal.md (last 3 entries)', '').trim();
        // Show truncated
        console.log(journalText.slice(0, 500));
        if (journalText.length > 500) console.log('  ...(truncated)');
      }
    } catch {
      console.log('\n[memory vault unreachable — running without context]');
    }

    console.log(`\n${IDENTITY.name} здесь. Готов к работе.`);
  });

// ─── Cron command ─────────────────────────────────────────────────────────────

const cronCmd = program
  .command('cron')
  .description('Periodic self-check — writes health reports to memory');

cronCmd
  .command('once')
  .description('Run one health check, persist to disk')
  .action(async () => {
    const report = await runAndPersist();
    console.log(formatHealthReport(report));
  });

cronCmd
  .command('start')
  .description('Start recurring health check (default: every 30 min)')
  .option('-i, --interval <minutes>', 'Check interval in minutes', '30')
  .action(async (opts) => {
    const interval = parseInt(opts.interval, 10) || 30;
    console.log(`[cron] Starting self-check every ${interval} minutes. Ctrl+C to stop.`);
    const { stop } = startCron(interval);
    process.on('SIGINT', () => {
      stop();
      console.log('\n[cron] Stopped.');
      process.exit(0);
    });
    // Keep process alive
    await new Promise(() => {});
  });

cronCmd
  .command('status')
  .description('Show last health report')
  .action(async () => {
    const report = await readLastReport();
    if (!report) {
      console.log('No health reports yet. Run: atlas cron once');
      return;
    }
    console.log(report);
  });

// ─── Health command (alias) ───────────────────────────────────────────────────

program
  .command('health')
  .description('Quick health check (no persist)')
  .action(() => {
    const report = runHealthCheck();
    console.log(formatHealthReport(report));
    process.exit(report.failed > 0 ? 1 : 0);
  });

// --- Status command (parity with Telegram /status) ---

program
  .command('status')
  .description("One-line status: health, today's spend, brain-loop queue, heartbeat")
  .action(async () => {
    const { buildStatusReport } = await import('./atlas/status-report.js');
    console.log(buildStatusReport());
  });

// --- Supervised Assist (M7) ---

const assistCmd = program
  .command('assist')
  .description('Supervised browser assist — CEO-approved answer pack fill');

assistCmd
  .command('run <plan>')
  .description('Fill a form using an approved answer pack (foreground TTY only)')
  .requiredOption('--answers <packPath>', 'Path to the JSON answer pack file')
  .action(async (plan: string, opts: { answers: string }) => {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const { createAnswerPack, validatePack } = await import('./hands/assist-contract.js');
    const { requestApproval, isForegroundTTY } = await import('./hands/assist-approval-port.js');
    const { runSupervisedAssist } = await import('./hands/supervised-assist.js');

    if (!isForegroundTTY()) {
      console.error('ERROR: atlas assist run requires a foreground TTY. Headless/non-TTY refused.');
      process.exit(1);
    }

    let pack;
    try {
      pack = JSON.parse(readFileSync(opts.answers, 'utf8'));
    } catch (e: any) {
      console.error(`ERROR: cannot read answer pack: ${e.message}`);
      process.exit(1);
    }

    // Print pack summary for CEO review
    console.log('\n=== ANSWER PACK SUMMARY ===');
    console.log(`Origin: ${pack.origin}`);
    console.log(`Form: ${pack.formFingerprint}`);
    console.log(`Fields:`);
    for (const f of pack.fields ?? []) {
      console.log(`  ${f.label}: "${f.value}"`);
    }
    console.log(`Pack hash: ${pack.packHash}`);
    console.log(`Expires: ${pack.expiresAt}`);

    // Request TTY approval
    const approval = await requestApproval(pack);
    if (!approval.approved) {
      console.error(`\nApproval denied: ${approval.reason}`);
      process.exit(1);
    }

    console.log('\nApproved. Starting supervised assist session...');

    const actionPlanHash = createHash('sha256').update(plan).digest('hex');
    const result = await runSupervisedAssist({
      pack,
      capability: approval.capability!,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });

    if (result.halted) {
      console.error(`\nHALTED: ${result.haltReason} — ${result.haltDetail}`);
      process.exit(1);
    }

    console.log(`\nCompleted: ${result.fieldsFilled}/${result.fieldsAttempted} fields filled.`);
    console.log('Final submit is left to the human.');
  });

// ─── Runner (L2 local-node command executor) ─────────────────────────────────
// Claims work from Supabase atlas_command_queue, red-line checks, executes
// locally via task-spawner, writes results back. See §6.2 of ATLAS-ARCHITECTURE.md.

const runnerCmd = program
  .command('runner')
  .description('L2 local-node runner — claim + execute commands from the queue');

runnerCmd
  .command('status')
  .description('Is the local runner alive? (reads the instance-lease heartbeat)')
  .action(async () => {
    try {
      const { runnerLivenessNow } = await import('./atlas/atlas-runner.js');
      const report = runnerLivenessNow();
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'running' ? 0 : 1;
    } catch (err) {
      console.error(`runner status error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

runnerCmd
  .command('peek')
  .description('Read-only: show the most recent atlas_command_queue rows (any status)')
  .option('-n, --limit <n>', 'How many rows', '10')
  .action(async (opts) => {
    try {
      const { peekQueue } = await import('./atlas/supabase-memory.js');
      const rows = await peekQueue(parseInt(opts.limit, 10) || 10);
      console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
      console.error(`runner peek error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

runnerCmd
  .command('tick')
  .description('Run exactly ONE runner tick (claim → check → execute → result as JSON)')
  .action(async () => {
    try {
      const { defaultRunnerDeps, runnerTick } = await import('./atlas/atlas-runner.js');
      const deps = defaultRunnerDeps();
      const result = await runnerTick(deps);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`runner tick error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

runnerCmd
  .command('start')
  .description('Run the runner loop — claims and executes until Ctrl-C')
  .option('-i, --interval <seconds>', 'Seconds between ticks', '15')
  .option('--allow-stale-dist', 'UNSAFE: start even if dist/ is older than src/', false)
  .action(async (opts) => {
    const intervalSec = parseInt(opts.interval, 10) || 15;

    // Startup gate: never silently run a build that predates src/. A stale
    // dist is invisible at runtime — safety gates you believe are live may
    // not exist in the binary at all (found live 2026-07-28: the autostarted
    // runner was executing a build older than queue-auth.ts, so the P0.1
    // signing gate was inert with no signal). Refuse loudly instead.
    const { inspectBuildFreshness, formatStaleDistError, runnerStartAllowed } = await import('./atlas/build-freshness.js');
    const freshness = inspectBuildFreshness();
    if (freshness.status === 'stale') {
      console.error(formatStaleDistError(freshness));
      const override = opts.allowStaleDist === true || process.env.ATLAS_ALLOW_STALE_DIST === '1';
      if (!runnerStartAllowed(freshness, override)) {
        process.exitCode = 1;
        return;
      }
      console.error('[runner] stale-dist override active — starting anyway. This is UNSAFE.');
    }

    try {
      const { defaultRunnerDeps, runRunnerLoop, recordRunnerStartState } = await import('./atlas/atlas-runner.js');

      // Declare our own state into the lease so `runner status` reports the
      // RUNNER's enforcement, not the reader's env.
      const record = recordRunnerStartState(ownedInstanceLeaseId, {}, freshness);
      console.log(`[runner] authEnforcement=${record.authEnforcement} build=${freshness.status}`);
      if (!record.recorded) {
        console.error('[runner] REFUSING TO START — this process does not own the instance lease.');
        process.exitCode = 1;
        return;
      }

      const deps = defaultRunnerDeps();
      console.log(`[runner] Starting local runner (interval ${intervalSec}s). Ctrl+C to stop.`);
      console.log(`[runner] workerId=${deps.workerId}`);
      await runRunnerLoop(deps, {
        tickIntervalMs: intervalSec * 1000,
        onTick: (r) => {
          const ts = new Date().toISOString().slice(11, 19);
          console.log(`[runner ${ts}] ${JSON.stringify(r)}`);
        },
      });
      console.log('[runner] Stopped.');
    } catch (err) {
      console.error(`runner start error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('evidence')
  .description('M8 evidence ledger tools')
  .command('audit')
  .description('Run read-only evidence auditor against ledger')
  .option('--ledger <dir>', 'Evidence dir (default ATLAS_EVIDENCE_DIR or state/evidence)')
  .action(async (opts: { ledger?: string }) => {
    if (opts.ledger) process.env.ATLAS_EVIDENCE_DIR = opts.ledger;
    const { runEvidenceAudit } = await import('./evidence/auditor.js');
    const summary = runEvidenceAudit();
    console.log(JSON.stringify({
      auditRunId: summary.auditRunId,
      findingsCount: summary.findingsCount,
      adversarialLogPath: summary.adversarialLogPath,
      findings: summary.findings,
    }, null, 2));
    process.exitCode = 0;
  });

program
  .command('learning')
  .description('Sprint 1 VOLAURA learning NBA exchange tools')
  .command('drain')
  .description('Process pending VOLAURA learning requests into receipts')
  .action(async () => {
    const {
      listPendingLearningRequests,
      readLearningRequest,
      processLearningRequest,
    } = await import('./learning/request-port.js');
    const paths = listPendingLearningRequests();
    for (const p of paths) {
      const req = readLearningRequest(p);
      const receipt = await processLearningRequest(req);
      console.log(JSON.stringify(receipt));
    }
  });

program
  .command('opsboard')
  .description('M9 OPSBOARD exchange tools')
  .command('drain')
  .description('Process pending OPSBOARD goal requests into receipts')
  .action(async () => {
    const {
      listPendingRequests,
      readGoalRequest,
      processGoalRequest,
    } = await import('./opsboard/goal-request-port.js');
    const { runGoal } = await import('./goal-runner/runner.js');
    const paths = listPendingRequests();
    for (const p of paths) {
      const req = readGoalRequest(p);
      const receipt = await processGoalRequest(req, {
        run: async ({ objective, handId, timeoutMs }) => {
          const report = await runGoal({
            objective,
            handId,
            browserActions: [],
            config: {
              maxAttemptsPerTask: 1,
              maxTotalAttempts: 1,
              maxTotalTasks: 5,
              maxDecompositionRounds: 1,
              maxGraphDepth: 3,
              maxWallTimeMs: timeoutMs,
            },
            notifyCeo: async () => ({ result: 'SUPPRESSED' }),
          });
          return { status: report.status, goalId: report.goalId, report };
        },
      });
      console.log(JSON.stringify(receipt));
    }
  });

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.js')) {
  if (shouldAcquireInstanceLease(process.argv.slice(2))) {
    const instanceLease = acquireInstanceLease();
    if (instanceLease.mode === 'readonly') {
      console.error(`[atlas] READ-ONLY MODE: ${instanceLease.reason ?? 'another instance holds the lease'}`);
      process.env.ATLAS_READONLY = '1';
    } else {
      ownedInstanceLeaseId = instanceLease.instanceId;
      startInstanceLeaseHeartbeat(instanceLease.instanceId);
    }
  }
  const exit = process.exit.bind(process);
  process.exit = ((code?: number) => {
    if (!assertBreadcrumbBeforeExit().ok) {
      try {
        writeSessionBreadcrumb(`auto-exit:${process.argv.slice(2).join(' ').slice(0, 120)}`);
      } catch { /* ignore */ }
    }
    return exit(code);
  }) as typeof process.exit;
  program.parse();
}
