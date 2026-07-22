/**
 * hands/browser-adapter.ts — Playwright driver for the browser Hand.
 *
 * Executes structured BrowserActions (from browser-actions.ts) via Playwright.
 * NO arbitrary command strings — every operation is a typed, enumerated action
 * validated by the browserActionSchema before execution.
 *
 * The adapter manages a single browser session: launch → execute actions →
 * collect results → close. Each action produces a BrowserActionResult with
 * success/failure and optional extracted value.
 *
 * Security: the adapter never executes free-form JS, never touches credentials
 * or cookies from other sessions, and never submits forms (submit is not in
 * the action vocabulary).
 */

import type { Browser, Page } from 'playwright';
import { browserActionSchema, type BrowserAction, type BrowserActionResult } from './browser-actions.js';

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    // Dynamic import so playwright is only loaded when the browser Hand is used,
    // not at module load time (keeps the test suite fast for non-browser tests).
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Execute a single structured browser action. Returns a deterministic result.
   * Throws if the action doesn't parse against the closed enum schema.
   */
  async execute(action: BrowserAction): Promise<BrowserActionResult> {
    // Validate against the closed schema — rejects any out-of-vocabulary action
    browserActionSchema.parse(action);

    if (!this.page) {
      return { action, success: false, error: 'Browser session not launched' };
    }

    try {
      switch (action.kind) {
        case 'navigate': {
          await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
          return { action, success: true, value: this.page.url() };
        }

        case 'readText': {
          const el = this.page.locator(action.selector).first();
          const text = await el.textContent({ timeout: 5000 });
          return { action, success: true, value: text ?? '' };
        }

        case 'readValue': {
          const el = this.page.locator(action.selector).first();
          const value = await el.inputValue({ timeout: 5000 });
          return { action, success: true, value };
        }

        case 'click': {
          await this.page.getByRole(action.role as any, { name: action.name }).click({ timeout: 5000 });
          return { action, success: true };
        }

        case 'fillField': {
          await this.page.getByLabel(action.label).fill(action.value);
          return { action, success: true, value: action.value };
        }

        case 'selectOption': {
          await this.page.getByLabel(action.label).selectOption({ label: action.value });
          return { action, success: true, value: action.value };
        }

        default: {
          const _exhaustive: never = action;
          return { action: action as BrowserAction, success: false, error: `Unknown action kind: ${(action as any).kind}` };
        }
      }
    } catch (err) {
      return {
        action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute a sequence of actions, collecting results. Stops on first failure.
   */
  async executeSequence(actions: BrowserAction[]): Promise<BrowserActionResult[]> {
    const results: BrowserActionResult[] = [];
    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }
}
