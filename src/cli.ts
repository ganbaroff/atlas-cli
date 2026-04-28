#!/usr/bin/env node
/**
 * Atlas CLI — persistent AI agent, core of the VOLAURA ecosystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from 'commander';
import { createAtlasAgent, listAvailableModels } from './agent.js';
import { appendMessage, loadConversation } from './atlas/conversation-store.js';
import { IDENTITY } from './atlas/identity.js';
import { loadWakeContext, appendJournal, writeHeartbeat } from './atlas/memory-manager.js';
import { callPythonSwarm, isPythonSwarmAvailable, loadHiveProfiles } from './atlas/python-bridge.js';
import { runAndPersist, readLastReport, startCron } from './atlas/cron.js';
import { runHealthCheck, formatHealthReport } from './atlas/health-check.js';
import type { ModelRole } from './model-router.js';
import * as readline from 'node:readline';

// Load .env without dependency
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
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

    // Wake protocol: inject persistent memory into system prompt
    let wakeContext = '';
    try {
      wakeContext = await loadWakeContext();
    } catch {
      // vault unreachable — continue without memory
    }

    const agent = await createAtlasAgent(role, wakeContext);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

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

        try {
          const response = await agent.generate(messages);
          const reply = response.text;
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
    const agent = await createAtlasAgent(role);

    const contextExtra = opts.context ? `\nAdditional context: ${opts.context}` : '';
    const prompt = `Load the skill "${skill}" using the load-skill tool and execute it against the current working directory (${process.cwd()}). Follow the skill spec precisely. Use your other tools (read-file, glob, grep, shell) as needed to gather the input data the skill requires.${contextExtra}`;

    console.log(`\n${IDENTITY.name} запускает скилл: ${skill}\n`);

    try {
      const response = await agent.generate(prompt);
      console.log(response.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command('identity')
  .description('Show Atlas identity')
  .action(() => {
    console.log(JSON.stringify(IDENTITY, null, 2));
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
  .command('skills')
  .description('List available VOLAURA skills')
  .action(async () => {
    const agent = await createAtlasAgent('FAST');
    try {
      const res = await agent.generate('List all available skills. Use the list-skills tool. Output just the names, one per line.');
      console.log(res.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    }
  });

program
  .command('swarm <task>')
  .description('Decompose task into parallel agent workers across providers')
  .action(async (task: string) => {
    const { runSwarm } = await import('./swarm.js');
    console.log(`\n${IDENTITY.name} запускает swarm\n`);
    try {
      const result = await runSwarm(task);
      console.log('\n' + result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Swarm failed: ${msg}`);
      process.exit(1);
    }
  });

program
  .command('swarm-deep <task>')
  .description('Route task to VOLAURA Python swarm (13 perspectives, 4 DAG waves)')
  .option('-m, --mode <mode>', 'Swarm mode: coordinator, daily-ideation, code-review', 'coordinator')
  .action(async (task: string, opts) => {
    if (!isPythonSwarmAvailable()) {
      console.error('VOLAURA Python swarm not found at C:\\Projects\\VOLAURA');
      console.log('Falling back to TypeScript swarm...');
      const { runSwarm } = await import('./swarm.js');
      const result = await runSwarm(task);
      console.log('\n' + result);
      return;
    }

    console.log(`\n${IDENTITY.name} вызывает Python swarm (mode: ${opts.mode})\n`);
    const result = await callPythonSwarm(task, opts.mode);
    if (result.success) {
      console.log(`\n[bridge] ${result.proposals.length} proposals received from Python swarm`);
      for (const p of result.proposals.slice(0, 5)) {
        const prop = p as Record<string, unknown>;
        console.log(`  [${prop['severity'] ?? '?'}] ${String(prop['title'] ?? prop['summary'] ?? '').slice(0, 80)}`);
      }
    } else {
      console.error(`[bridge] Python swarm failed: ${result.error}`);
      console.log('Falling back to TypeScript swarm...');
      const { runSwarm } = await import('./swarm.js');
      const fallback = await runSwarm(task);
      console.log('\n' + fallback);
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
    try {
      const agent = await createAtlasAgent('FAST');
      const response = await agent.generate('respond with exactly: Атлас здесь.');
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
        const kvLines = hbBody.split('\n').filter(l => l.startsWith('**') || l.startsWith('Updated:'));
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
          const relLines = relBody.split('\n').filter(l => l.trim()).slice(0, 3);
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
            .filter(l => l.startsWith('##') || l.match(/^\d{4}-\d{2}-\d{2}/))
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

program.parse();
