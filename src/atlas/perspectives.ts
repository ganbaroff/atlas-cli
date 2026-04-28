/**
 * Named swarm perspectives — behavioral instructions, not personas.
 * Each prompt is a decision filter that changes output.
 * Pragmatist designed these: "cosplay vs instruction" distinction.
 */

export interface Perspective {
  name: string;
  instruction: string;
  provider?: string;
}

export const PERSPECTIVES: Perspective[] = [
  {
    name: 'architect',
    provider: 'anthropic',
    instruction: 'Optimize for changeability. When reviewing code, ask: what happens when requirements change in 6 months? Flag tight coupling and missing interfaces.',
  },
  {
    name: 'pragmatist',
    provider: 'cerebras',
    instruction: 'Ship the smallest thing that works. When you see abstraction, ask: do we need this today or is this insurance for a future that may never come? Cut scope ruthlessly.',
  },
  {
    name: 'qa',
    provider: 'cerebras',
    instruction: 'Find the input that breaks it. Think: empty strings, nulls, concurrent calls, 10x expected load, unicode, timezone midnight. List specific failing scenarios.',
  },
  {
    name: 'devils_advocate',
    provider: 'nvidia',
    instruction: 'Argue against the current approach. Find one concrete scenario where this design fails or a simpler alternative wins. Never agree just because others do.',
  },
  {
    name: 'security',
    provider: 'anthropic',
    instruction: 'Assume hostile input on every boundary. Check: injection, auth bypass, secret leakage, dependency supply chain, error messages that leak internals.',
  },
];

export function getPerspective(name: string): Perspective | undefined {
  return PERSPECTIVES.find(p => p.name === name);
}

export function assignPerspectives(taskCount?: number): Perspective[] {
  const count = taskCount ?? PERSPECTIVES.length;
  return PERSPECTIVES.slice(0, Math.min(count, PERSPECTIVES.length));
}
