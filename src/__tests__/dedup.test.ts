import { describe, it, expect } from 'vitest';
import { dedupFindings } from '../atlas/dedup.js';

describe('dedup', () => {
  it('returns all unique sentences when no overlap', () => {
    const outputs = [
      'The authentication system needs rate limiting.',
      'Database indexes should be optimized for query patterns.',
    ];
    const result = dedupFindings(outputs);
    expect(result.unique.length).toBe(2);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it('removes near-duplicate sentences across perspectives', () => {
    const outputs = [
      'The API needs rate limiting to prevent abuse and protect the system. The database connection pool is too small.',
      'The API needs rate limiting to prevent abuse and protect the endpoints. Memory usage is too high.',
    ];
    const result = dedupFindings(outputs, 0.5);
    // Nearly identical "rate limiting" sentences should be deduped
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
    expect(result.unique.length).toBeLessThan(result.totalInput);
  });

  it('handles empty input', () => {
    const result = dedupFindings([]);
    expect(result.unique).toEqual([]);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.totalInput).toBe(0);
  });

  it('handles single perspective', () => {
    const result = dedupFindings(['One finding. Another finding.']);
    expect(result.unique.length).toBe(2);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it('threshold=1.0 means only exact matches dedup', () => {
    const outputs = [
      'The system needs better error handling for edge cases.',
      'The system needs better error handling for edge cases.',
    ];
    const result = dedupFindings(outputs, 1.0);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it('filters short sentences (<10 chars)', () => {
    const result = dedupFindings(['OK. Good. This is a longer sentence that should be kept.']);
    // "OK" and "Good" should be filtered out
    expect(result.unique.length).toBe(1);
  });
});
