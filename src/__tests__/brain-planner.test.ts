import { describe, expect, it } from 'vitest';
import { buildAtlasBrainPlan } from '../atlas/brain-planner.js';

describe('Atlas brain planner', () => {
  it('builds one state-driven prompt path for Telegram', async () => {
    const plan = await buildAtlasBrainPlan({
      channel: 'telegram',
      role: 'WORKER',
      state: {
        status: 'first_slice_contract_live',
        phase: { next: 'brain + executor proof', implemented: true, name: 'contract_first' },
        control: {
          mode: 'active',
          next_lane: 'brain + executor proof',
        },
        last_run: {
          task_id: 'openmanus-smoke-readonly',
          status: 'success',
          reason: 'OpenManus local smoke executed.',
          executor: 'openmanus',
          started_at: '2026-05-31T15:23:48.916Z',
          completed_at: '2026-05-31T15:26:36.384Z',
          trace_path: 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS\\operator\\runs\\openmanus-smoke-readonly.result.json',
          proof_tokens: [
            'openmanus-smoke-readonly.cwd',
            'openmanus-smoke-readonly.command',
            'openmanus-smoke-readonly.log',
            'openmanus-smoke-readonly.browser',
            'openmanus-smoke-readonly.browser.trace',
          ],
          evidence_types: [
            'file_exists',
            'command_exit',
            'log_trace',
            'browser_observation',
            'browser_session_trace',
          ],
        },
      },
      brainContext: 'brain-context',
      lessons: 'lesson-context',
    });

    expect(plan.source).toBe('brain');
    expect(plan.canCallModel).toBe(true);
    expect(plan.systemPrompt).toContain('brain-context');
    expect(plan.operatorContext).toContain('## OPERATOR STATE');
    expect(plan.operatorContext).toContain('openmanus-smoke-readonly');
    expect(plan.operatorContext).toContain('browser_session_trace');
    expect(plan.systemPrompt).toContain('brain + executor proof');
    expect(plan.systemPrompt).toContain('openmanus-smoke-readonly');
    expect(plan.systemPrompt).toContain('browser_session_trace');
    expect(plan.systemPrompt).toContain('lesson-context');
  });
});
