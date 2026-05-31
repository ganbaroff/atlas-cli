import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const sleep = (ms) => new Promise((resolveSleep) => {
  setTimeout(resolveSleep, ms);
});

const targetRoot = resolve(process.env.OCTOGENT_LIVE_TARGET_ROOT ?? 'C:/Projects/octogent');
const startPort = Number.parseInt(process.env.OCTOGENT_LIVE_PORT ?? '8795', 10);
const parentTerminalId = process.env.OCTOGENT_LIVE_PARENT_ID ?? 'octogent-live-parent';
const childTerminalId = process.env.OCTOGENT_LIVE_CHILD_ID ?? 'octogent-live-child';
const parentPrompt = process.env.OCTOGENT_LIVE_PARENT_PROMPT ?? 'Live parent ready.';
const childPrompt = process.env.OCTOGENT_LIVE_CHILD_PROMPT ?? 'Live child ready.';
const parentToChildMessage =
  process.env.OCTOGENT_LIVE_PARENT_MESSAGE ?? 'Need ACK from child.';
const childToParentMessage =
  process.env.OCTOGENT_LIVE_CHILD_MESSAGE ?? 'ACK: live worker online.';

const serverEnv = {
  ...process.env,
  OCTOGENT_API_PORT: Number.isFinite(startPort) ? String(startPort) : '8795',
  OCTOGENT_NO_OPEN: '1',
  CI: '1',
};

const fetchJson = async (url, init) => {
  const response = await fetch(url, init);
  const raw = await response.text();
  const trimmed = raw.trim();
  let parsed = null;

  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed;
    }
  }

  if (!response.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`${init?.method ?? 'GET'} ${url} failed (${response.status}): ${detail}`);
  }

  return parsed;
};

const waitFor = async (label, check, timeoutMs = 60000, intervalMs = 250) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const value = await check();
    if (value) {
      return value;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}.`);
};

const ensureDelivered = async (baseUrl, terminalId, messageId) => {
  return waitFor(`delivery for ${terminalId}`, async () => {
    const payload = await fetchJson(`${baseUrl}/api/channels/${encodeURIComponent(terminalId)}/messages`);
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const match = messages.find((message) => message?.messageId === messageId);
    return match && match.delivered ? payload : null;
  });
};

const createTerminal = async (baseUrl, payload) => {
  return fetchJson(`${baseUrl}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
};

const sendChannelMessage = async (baseUrl, terminalId, fromTerminalId, content) => {
  return fetchJson(`${baseUrl}/api/channels/${encodeURIComponent(terminalId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fromTerminalId, content }),
  });
};

const main = async () => {
  const server = spawn(process.execPath, [join(targetRoot, 'bin', 'octogent')], {
    cwd: targetRoot,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const shutdown = async () => {
    if (server.exitCode !== null || server.signalCode !== null) {
      return;
    }

    server.kill('SIGTERM');
    await waitFor(
      'server shutdown',
      () => (server.exitCode !== null || server.signalCode !== null ? true : null),
      5000,
      100,
    ).catch(() => {
      server.kill('SIGKILL');
    });
  };

  try {
    const apiBaseUrl = await waitFor('Octogent API start', () => {
      const match = stdout.match(/API:\s+http:\/\/127\.0\.0\.1:(\d+)/m);
      return match ? `http://127.0.0.1:${match[1]}` : null;
    });

    const parent = await createTerminal(apiBaseUrl, {
      terminalId: parentTerminalId,
      name: 'Live Parent',
      workspaceMode: 'shared',
      initialPrompt: parentPrompt,
    });
    const child = await createTerminal(apiBaseUrl, {
      terminalId: childTerminalId,
      name: 'Live Child',
      workspaceMode: 'shared',
      parentTerminalId,
      initialPrompt: childPrompt,
    });

    const parentToChild = await sendChannelMessage(
      apiBaseUrl,
      childTerminalId,
      parentTerminalId,
      parentToChildMessage,
    );
    const childToParent = await sendChannelMessage(
      apiBaseUrl,
      parentTerminalId,
      childTerminalId,
      childToParentMessage,
    );

    const parentMessages = await ensureDelivered(
      apiBaseUrl,
      parentTerminalId,
      childToParent.messageId,
    );
    const childMessages = await ensureDelivered(
      apiBaseUrl,
      childTerminalId,
      parentToChild.messageId,
    );
    const snapshots = await fetchJson(`${apiBaseUrl}/api/terminal-snapshots`, {
      headers: { Accept: 'application/json' },
    });

    const result = {
      apiBaseUrl,
      parent,
      child,
      sent: {
        parentToChild,
        childToParent,
      },
      parentMessages,
      childMessages,
      snapshots,
      trace: [
        `spawned ${parentTerminalId} pid=${parent.processId ?? 'unknown'} state=${parent.lifecycleState}`,
        `spawned ${childTerminalId} pid=${child.processId ?? 'unknown'} state=${child.lifecycleState}`,
        `delivered parent->child=${parentToChild.delivered ? 'yes' : 'no'}`,
        `delivered child->parent=${childToParent.delivered ? 'yes' : 'no'}`,
      ],
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await shutdown();
    if (stdout.length > 0 && process.env.OCTOGENT_LIVE_DEBUG === '1') {
      process.stderr.write(`\n[octogent-live stdout]\n${stdout}`);
    }
    if (stderr.length > 0 && process.env.OCTOGENT_LIVE_DEBUG === '1') {
      process.stderr.write(`\n[octogent-live stderr]\n${stderr}`);
    }
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
