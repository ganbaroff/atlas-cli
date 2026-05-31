import { describe, expect, it } from 'vitest';
import { buildBrowserSessionTraceEvidence } from '../operator/browser-trace.js';

describe('browser session trace', () => {
  it('turns browser observation into durable trace evidence', () => {
    const evidence = buildBrowserSessionTraceEvidence({
      taskId: 'openmanus-smoke-readonly',
      tracePath: 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/operator/runs/openmanus-smoke-readonly.result.json',
      evidence: [
        {
          id: 'openmanus-smoke-readonly.browser',
          task_id: 'openmanus-smoke-readonly',
          type: 'browser_observation',
          source: 'https://example.com',
          observed_at: '2026-05-31T00:00:00.000Z',
          summary: 'Observed Example Domain',
          data: {},
          proof_token: 'openmanus-smoke-readonly.browser',
        },
      ],
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.type).toBe('browser_session_trace');
    expect(evidence[0]?.proof_token).toBe('openmanus-smoke-readonly.browser.trace');
    expect(evidence[0]?.data).toMatchObject({
      trace_path: 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/operator/runs/openmanus-smoke-readonly.result.json',
      browser_observation_id: 'openmanus-smoke-readonly.browser',
      browser_source: 'https://example.com',
      browser_summary: 'Observed Example Domain',
    });
  });
});
