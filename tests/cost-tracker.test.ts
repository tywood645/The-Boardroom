import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CostTracker } from '../src/cost/tracker.js';

describe('CostTracker', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boardroom-cost-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes cost using model pricing table', () => {
    const tracker = new CostTracker();
    const { cost } = tracker.recordUsage('claude-sonnet-4-20250514', 1000, 500);
    assert.ok(Math.abs(cost - 0.0105) < 0.0001);
  });

  it('accumulates session stats across calls', () => {
    const tracker = new CostTracker();
    tracker.recordUsage('gpt-4o', 100, 50);
    tracker.recordUsage('deepseek-chat', 200, 100);
    const stats = tracker.getSessionStats();
    assert.equal(stats.inputTokens, 300);
    assert.equal(stats.outputTokens, 150);
  });

  it('blocks when session cap exceeded', () => {
    const tracker = new CostTracker({ sessionCap: 0.001 });
    const { alert } = tracker.recordUsage('claude-opus-4-20250514', 1000, 1000);
    // opus: (1000*15 + 1000*75)/1M = 0.09 >> 0.001
    assert.ok(alert);
    assert.equal(alert!.type, 'blocked');
  });
});
