/**
 * adapter.chatgpt-browser-reviewer — dedicated ChatGPT reviewer transport.
 * Playwright + Atlas quarantine profile. One ChatGPT host only. Not final proof.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHATGPT_BROWSER_REVIEWER_ADAPTER_ID = 'adapter.chatgpt-browser-reviewer';

export type ChatGptVerdict = 'ACCEPT' | 'REPAIR' | 'REJECT';

export type CourierReviewRequest = {
  goal: string;
  allowedScope: string[];
  diff: string;
  testEvidence: string;
  effectProofsJson: string;
  contractNotes: string;
};

export type ChatGptReviewResult = {
  adapterId: typeof CHATGPT_BROWSER_REVIEWER_ADAPTER_ID;
  verdict: ChatGptVerdict | null;
  repairInstruction: string | null;
  responseText: string;
  responseHash: string;
  submittedMessageHash: string;
  screenshotPath: string | null;
  timestamps: { startedAt: string; completedAt: string };
  browserErrors: string[];
  loginRequired: boolean;
  emptyOrDuplicate: boolean;
};

export class ChatGptBrowserReviewerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'LOGIN_REQUIRED'
      | 'PAGE_LOAD'
      | 'GENERATION_TIMEOUT'
      | 'EMPTY_OR_DUPLICATE'
      | 'OUT_OF_SCOPE'
      | 'HOST_FORBIDDEN'
      | 'CONFIG',
  ) {
    super(message);
    this.name = 'ChatGptBrowserReviewerError';
  }
}

const ALLOWED_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);

export type ChatGptBrowserKind = 'chrome' | 'comet' | 'chromium';

export type ChatGptReviewerOptions = {
  profileDir: string;
  evidenceDir: string;
  startUrl?: string;
  timeoutMs: number;
  request: CourierReviewRequest;
  /** Prior response hash to detect duplicates */
  priorResponseHash?: string;
  headless?: boolean;
  /** chrome (stable) | comet | bundled chromium. Default: chrome. */
  browserKind?: ChatGptBrowserKind;
  /** If login wall appears, wait this many ms for CEO manual login (no credential copy). */
  waitForManualLoginMs?: number;
  /** Test seam — inject fake browser ops */
  driver?: ChatGptBrowserDriver;
};

const CHROME_STABLE =
  process.env.ATLAS_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COMET_EXE =
  process.env.ATLAS_COMET_PATH ??
  'C:\\Users\\user\\AppData\\Local\\Perplexity\\Comet\\Application\\comet.exe';

export function resolveChatGptBrowserLaunch(kind: ChatGptBrowserKind = 'chrome'): {
  channel?: 'chrome';
  executablePath?: string;
  kind: ChatGptBrowserKind;
} {
  if (kind === 'comet') {
    if (!existsSync(COMET_EXE)) {
      throw new ChatGptBrowserReviewerError(`Comet not found: ${COMET_EXE}`, 'CONFIG');
    }
    return { executablePath: COMET_EXE, kind: 'comet' };
  }
  if (kind === 'chrome') {
    if (!existsSync(CHROME_STABLE)) {
      throw new ChatGptBrowserReviewerError(`Chrome stable not found: ${CHROME_STABLE}`, 'CONFIG');
    }
    // Prefer channel so Playwright uses installed stable Chrome (not Beta/bundled).
    return { channel: 'chrome', kind: 'chrome' };
  }
  return { kind: 'chromium' };
}

export type ChatGptBrowserDriver = {
  open(url: string): Promise<{ loginWall: boolean; loadOk: boolean; error?: string }>;
  waitForLoginClear?(timeoutMs: number): Promise<boolean>;
  submit(message: string): Promise<void>;
  waitGenerationComplete(timeoutMs: number): Promise<{ ok: boolean; text: string; error?: string }>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function assertAllowedChatGptUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new ChatGptBrowserReviewerError(`invalid url: ${url}`, 'HOST_FORBIDDEN');
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ChatGptBrowserReviewerError(`host not allowed: ${host}`, 'HOST_FORBIDDEN');
  }
}

export function formatReviewMessage(req: CourierReviewRequest): string {
  return [
    'You are a bounded code reviewer for Atlas courier-replacement proof.',
    'Return exactly one verdict line first: VERDICT: ACCEPT | VERDICT: REPAIR | VERDICT: REJECT',
    'If REPAIR, add one precise bounded instruction under REPAIR_INSTRUCTION:',
    'Do not request work outside the allowed scope.',
    '',
    `GOAL:\n${req.goal}`,
    '',
    `ALLOWED_SCOPE:\n${req.allowedScope.join('\n')}`,
    '',
    `DIFF:\n${req.diff}`,
    '',
    `TEST_EVIDENCE:\n${req.testEvidence}`,
    '',
    `EFFECT_PROOFS:\n${req.effectProofsJson}`,
    '',
    `CONTRACTS:\n${req.contractNotes}`,
  ].join('\n');
}

export function parseVerdict(text: string): { verdict: ChatGptVerdict | null; repairInstruction: string | null } {
  const verdictMatch = text.match(/VERDICT:\s*(ACCEPT|REPAIR|REJECT)\b/i);
  const verdict = verdictMatch ? (verdictMatch[1].toUpperCase() as ChatGptVerdict) : null;
  let repairInstruction: string | null = null;
  const repairMatch = text.match(/REPAIR_INSTRUCTION:\s*([\s\S]*?)(?:\n\s*VERDICT:|$)/i);
  if (repairMatch) repairInstruction = repairMatch[1].trim() || null;
  if (verdict === 'REPAIR' && !repairInstruction) {
    const after = text.split(/VERDICT:\s*REPAIR/i)[1] ?? '';
    repairInstruction = after.trim().slice(0, 2000) || null;
  }
  return { verdict, repairInstruction };
}

export function assertRepairInScope(instruction: string, allowedScope: string[]): void {
  const lower = instruction.toLowerCase();
  const forbidden = ['integronix', 'volaura', 'production', 'deploy', 'push ', '~/.codex', 'c:\\projects\\volaura'];
  for (const f of forbidden) {
    if (lower.includes(f)) {
      throw new ChatGptBrowserReviewerError(`repair requests out-of-scope work: ${f}`, 'OUT_OF_SCOPE');
    }
  }
  // soft check: mention at least one allowed path token if scope provided
  if (allowedScope.length > 0) {
    const hit = allowedScope.some((p) => lower.includes(p.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? ''));
    if (!hit && /(write|edit|change|modify|create)\s+([a-z0-9_./\\-]+)/i.test(instruction)) {
      // still allow if instruction is clearly about counter/test inside disposable
      if (!/counter|test|nextcount/i.test(instruction)) {
        throw new ChatGptBrowserReviewerError('repair instruction does not reference allowed scope', 'OUT_OF_SCOPE');
      }
    }
  }
}

async function createPlaywrightDriver(
  profileDir: string,
  headless: boolean,
  browserKind: ChatGptBrowserKind = 'chrome',
): Promise<ChatGptBrowserDriver> {
  const { chromium } = await import('playwright');
  mkdirSync(profileDir, { recursive: true });
  const launch = resolveChatGptBrowserLaunch(browserKind);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 720 },
    channel: launch.channel,
    executablePath: launch.executablePath,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  return {
    async open(url: string) {
      assertAllowedChatGptUrl(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (err) {
        return { loginWall: false, loadOk: false, error: err instanceof Error ? err.message : String(err) };
      }
      const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
      const loginWall =
        body.includes('log in') ||
        body.includes('sign in') ||
        (await page.getByRole('button', { name: /log in|sign in/i }).count()) > 0;
      return { loginWall, loadOk: true, error: errors[0] };
    },
    async waitForLoginClear(timeoutMs: number) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
        const loginWall =
          body.includes('log in') ||
          body.includes('sign in') ||
          (await page.getByRole('button', { name: /log in|sign in/i }).count()) > 0;
        const composer =
          (await page.locator('[data-testid="prompt-textarea"]').count()) > 0 ||
          (await page.locator('#prompt-textarea').count()) > 0 ||
          (await page.locator('div[contenteditable="true"]').count()) > 0;
        if (!loginWall && composer) return true;
        await page.waitForTimeout(2000);
      }
      return false;
    },
    async submit(message: string) {
      // ChatGPT uses a visible #prompt-textarea (often contenteditable) plus a hidden
      // fallback <textarea name="prompt-textarea">. Never click the hidden fallback.
      const candidates = [
        page.locator('#prompt-textarea[contenteditable="true"]'),
        page.locator('[data-testid="prompt-textarea"]'),
        page.locator('div#prompt-textarea'),
        page.getByRole('textbox', { name: /chat with chatgpt|message/i }),
        page.locator('textarea[name="prompt-textarea"]:visible'),
      ];
      let target = null as ReturnType<typeof page.locator> | null;
      for (const loc of candidates) {
        if ((await loc.count()) === 0) continue;
        const first = loc.first();
        if (await first.isVisible().catch(() => false)) {
          target = first;
          break;
        }
      }
      if (!target) {
        // last resort: any visible prompt-looking control
        const any = page.locator('#prompt-textarea').first();
        if ((await any.count()) === 0) throw new Error('prompt editor not found');
        target = any;
      }
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click({ force: true, timeout: 15_000 });
      // clear + insert
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      const tag = await target.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'textarea' || tag === 'input') {
        await target.fill(message);
      } else {
        // contenteditable — fill() often fails; use insertText
        await page.keyboard.insertText(message);
      }
      // allow React state to catch up
      await page.waitForTimeout(300);
      const send = page.getByRole('button', { name: /send message|send|submit/i }).first();
      if ((await send.count()) > 0 && (await send.isEnabled().catch(() => false))) {
        await send.click({ force: true });
      } else {
        await page.keyboard.press('Enter');
      }
    },
    async waitGenerationComplete(timeoutMs: number) {
      const started = Date.now();
      // Wait until a stop/generating control appears then disappears, or assistant text stabilizes
      let last = '';
      let stableRounds = 0;
      while (Date.now() - started < timeoutMs) {
        const stopVisible =
          (await page.getByRole('button', { name: /stop|stop generating/i }).count().catch(() => 0)) > 0;
        const texts = await page.locator('[data-message-author-role="assistant"]').allInnerTexts().catch(() => [] as string[]);
        const text = texts[texts.length - 1] ?? '';
        if (!stopVisible && text.length > 0) {
          if (text === last) {
            stableRounds += 1;
            if (stableRounds >= 3) return { ok: true, text };
          } else {
            stableRounds = 0;
            last = text;
          }
        }
        await page.waitForTimeout(1000);
      }
      return { ok: false, text: last, error: 'GENERATION_TIMEOUT' };
    },
    async screenshot(path: string) {
      await page.screenshot({ path, fullPage: true });
    },
    async close() {
      await context.close();
    },
  };
}

export async function reviewWithChatGpt(opts: ChatGptReviewerOptions): Promise<ChatGptReviewResult> {
  mkdirSync(opts.evidenceDir, { recursive: true });
  mkdirSync(opts.profileDir, { recursive: true });
  const startUrl = opts.startUrl ?? 'https://chatgpt.com/';
  assertAllowedChatGptUrl(startUrl);

  const message = formatReviewMessage(opts.request);
  const submittedMessageHash = sha256(message);
  const startedAt = new Date().toISOString();
  const driver =
    opts.driver ??
    (await createPlaywrightDriver(opts.profileDir, opts.headless ?? false, opts.browserKind ?? 'chrome'));
  const browserErrors: string[] = [];

  try {
    const opened = await driver.open(startUrl);
    if (!opened.loadOk) {
      throw new ChatGptBrowserReviewerError(opened.error ?? 'page load failed', 'PAGE_LOAD');
    }
    if (opened.loginWall) {
      const waitMs = opts.waitForManualLoginMs ?? 0;
      if (waitMs > 0 && driver.waitForLoginClear) {
        const cleared = await driver.waitForLoginClear(waitMs);
        if (!cleared) {
          return {
            adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
            verdict: null,
            repairInstruction: null,
            responseText: '',
            responseHash: sha256(''),
            submittedMessageHash,
            screenshotPath: null,
            timestamps: { startedAt, completedAt: new Date().toISOString() },
            browserErrors: ['LOGIN_REQUIRED'],
            loginRequired: true,
            emptyOrDuplicate: false,
          };
        }
      } else {
        return {
          adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
          verdict: null,
          repairInstruction: null,
          responseText: '',
          responseHash: sha256(''),
          submittedMessageHash,
          screenshotPath: null,
          timestamps: { startedAt, completedAt: new Date().toISOString() },
          browserErrors: ['LOGIN_REQUIRED'],
          loginRequired: true,
          emptyOrDuplicate: false,
        };
      }
    }

    await driver.submit(message);
    const gen = await driver.waitGenerationComplete(opts.timeoutMs);
    if (!gen.ok) {
      throw new ChatGptBrowserReviewerError(gen.error ?? 'generation timeout', 'GENERATION_TIMEOUT');
    }
    const responseText = gen.text.trim();
    const responseHash = sha256(responseText);
    const emptyOrDuplicate =
      responseText.length === 0 || (opts.priorResponseHash !== undefined && opts.priorResponseHash === responseHash);
    if (emptyOrDuplicate) {
      throw new ChatGptBrowserReviewerError('empty or duplicate reviewer response', 'EMPTY_OR_DUPLICATE');
    }

    const { verdict, repairInstruction } = parseVerdict(responseText);
    if (verdict === 'REPAIR' && repairInstruction) {
      assertRepairInScope(repairInstruction, opts.request.allowedScope);
    }

    const screenshotPath = join(opts.evidenceDir, `chatgpt-review-${Date.now()}.png`);
    try {
      await driver.screenshot(screenshotPath);
    } catch (err) {
      browserErrors.push(err instanceof Error ? err.message : String(err));
    }

    const completedAt = new Date().toISOString();
    const result: ChatGptReviewResult = {
      adapterId: CHATGPT_BROWSER_REVIEWER_ADAPTER_ID,
      verdict,
      repairInstruction,
      responseText,
      responseHash,
      submittedMessageHash,
      screenshotPath: existsSync(screenshotPath) ? screenshotPath : null,
      timestamps: { startedAt, completedAt },
      browserErrors,
      loginRequired: false,
      emptyOrDuplicate: false,
    };
    writeFileSync(join(opts.evidenceDir, `chatgpt-review-${Date.now()}.json`), JSON.stringify(result, null, 2), 'utf8');
    return result;
  } finally {
    await driver.close().catch(() => undefined);
  }
}
