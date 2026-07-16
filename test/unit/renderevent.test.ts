import { describe, it, expect } from 'vitest';
import { renderEvent } from '../../src/cli/lifecycle.js';
import type { TimestampedEvent } from '../../src/store/events.js';

const ev = (type: string, fields: Record<string, unknown> = {}): TimestampedEvent =>
  ({ ts: 1, type, ...fields }) as TimestampedEvent;

describe('renderEvent sanitization', () => {
  it('strips control bytes from worker-sourced fields (logs/--plain reach real TTYs)', () => {
    expect(renderEvent(ev('agent_started', { seq: 0, label: 'l\x1b[2J', backend: 'mock', model: 'm\x9b1J' }))).toBe(
      '   agent[0] l [2J started (mock · m 1J)',
    );
    expect(renderEvent(ev('agent_completed', { seq: 0, label: 'x', ok: false, totalTokens: 1, error: 'boom\nfake ✓ run completed\x1b[H' }))).toBe(
      '   agent[0] x FAILED: boom fake ✓ run completed [H',
    );
    expect(renderEvent(ev('workflow_log', { message: 'hi\x1b]0;spoof\x07' }))).toBe('   log: hi ]0;spoof ');
    expect(renderEvent(ev('agent_retry', { seq: 1, label: 'r', attempt: 2, maxAttempts: 3, reason: '\x1b[10Aup' }))).toBe(
      '   agent[1] r retry 2/3:  [10Aup',
    );
    expect(renderEvent(ev('child_started', { childId: 0, name: 'c\rname' }))).toBe('▸ child workflow: c name');
  });

  it('clean lines pass through unchanged; unknown types stay null', () => {
    expect(renderEvent(ev('run_started', { name: 'demo' }))).toBe('▶ run started: demo');
    expect(renderEvent(ev('agent_usage', { seq: 0, totalTokens: 5 }))).toBeNull();
    expect(renderEvent(ev('mystery_event', {}))).toBeNull();
  });
});
