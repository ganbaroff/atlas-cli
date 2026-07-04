import { describe, expect, it } from 'vitest';
import { formatReceipt, tailText } from '../atlas/receipt.js';

describe('receipt formatter', () => {
  it('attaches command and output tail', () => {
    const receipt = formatReceipt('/task smoke', 'line1\nline2');
    expect(receipt).toContain('Receipt');
    expect(receipt).toContain('command: /task smoke');
    expect(receipt).toContain('output_tail:');
    expect(receipt).toContain('line2');
  });

  it('tails long output instead of dumping everything', () => {
    const output = `${'x'.repeat(20)}END`;
    const tail = tailText(output, 5);
    expect(tail).toContain('...(tail)');
    expect(tail.endsWith('xxEND')).toBe(true);
  });
});
