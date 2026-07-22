/**
 * hands/browser-actions.ts — closed action vocabulary for the browser Hand.
 *
 * Every browser action the Hand can perform is an entry in BrowserActionKind.
 * NO arbitrary command strings, NO free-form shell, NO eval. An action not
 * in this enum is rejected at the schema level before execution.
 *
 * Each action is a structured object: kind + typed parameters. The adapter
 * validates the schema, executes via Playwright, and returns a deterministic
 * result (text content, field value, or void acknowledgment).
 */

import { z } from 'zod';

/** Closed enum — the ONLY browser operations the Hand may perform. */
export const browserActionKindSchema = z.enum([
  'navigate',     // go to a URL
  'readText',     // read text content of an element
  'readValue',    // read input/select value
  'click',        // click a button/link by role+name
  'fillField',    // type into an input by label
  'selectOption', // choose a <select> option by label
]);
export type BrowserActionKind = z.infer<typeof browserActionKindSchema>;

export const browserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'),     url: z.string().min(1) }),
  z.object({ kind: z.literal('readText'),     selector: z.string().min(1) }),
  z.object({ kind: z.literal('readValue'),    selector: z.string().min(1) }),
  z.object({ kind: z.literal('click'),        role: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal('fillField'),    label: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal('selectOption'), label: z.string().min(1), value: z.string().min(1) }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

export const browserActionResultSchema = z.object({
  action: browserActionSchema,
  success: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional(),
});
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;
