// Rotation tests.
//
// The point of rotation is that a vendor-effect claim is not secretly a
// role-effect claim. These tests assert the balance property mechanically,
// because a rotation that is subtly unbalanced still produces numbers, and
// those numbers would be wrong in a way no amount of reading the output reveals.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_ORDER, rotationAssignment, fullRotationCount,
  buildRotatedSeats, buildControlRotationSeats, isLatinSquare,
} from '../src/eval/rotation.js';
import { DEFAULT_ASSIGNMENT } from '../src/boardroom/roles.js';

const SIX = ['anthropic', 'openai', 'deepseek', 'xai', 'google', 'perplexity'];

const fakeConfigs = (names: string[]) =>
  names.map(name => ({ name, model: `${name}-model`, apiKey: 'k', baseUrl: 'https://x' })) as any[];

describe('rotationAssignment', () => {
  it('gives every vendor a distinct role within one rotation', () => {
    for (let r = 0; r < 6; r++) {
      const assignment = rotationAssignment(SIX, r);
      assert.equal(assignment.length, 6);
      assert.equal(new Set(assignment.map(a => a.role)).size, 6, `rotation ${r} repeats a role`);
      assert.equal(new Set(assignment.map(a => a.vendor)).size, 6, `rotation ${r} repeats a vendor`);
    }
  });

  it('forms a Latin square over a full cycle', () => {
    const rotations = Array.from({ length: 6 }, (_, r) => rotationAssignment(SIX, r));
    assert.ok(isLatinSquare(rotations), 'six rotations of six vendors must form a Latin square');
  });

  it('puts each vendor in each role exactly once across the cycle', () => {
    const rotations = Array.from({ length: 6 }, (_, r) => rotationAssignment(SIX, r));
    for (const vendor of SIX) {
      const roles = rotations.map(rot => rot.find(s => s.vendor === vendor)!.role);
      assert.deepEqual(
        [...roles].sort(), [...ROLE_ORDER].sort(),
        `${vendor} did not cover every role exactly once`,
      );
    }
  });

  it('does not depend on the order vendors were detected in', () => {
    const a = rotationAssignment(SIX, 2);
    const b = rotationAssignment([...SIX].reverse(), 2);
    assert.deepEqual(a, b, 'assignment must be stable under input reordering');
  });

  it('is stable across calls, so a rotation index is reproducible', () => {
    assert.deepEqual(rotationAssignment(SIX, 3), rotationAssignment(SIX, 3));
  });

  it('wraps, so rotation k equals rotation 0', () => {
    assert.deepEqual(rotationAssignment(SIX, 0), rotationAssignment(SIX, 6));
    assert.deepEqual(rotationAssignment(SIX, 1), rotationAssignment(SIX, 7));
  });

  it('handles negative rotation indices', () => {
    assert.deepEqual(rotationAssignment(SIX, -1), rotationAssignment(SIX, 5));
  });

  it('works for a partial board', () => {
    const three = ['anthropic', 'openai', 'google'];
    const rotations = Array.from({ length: 3 }, (_, r) => rotationAssignment(three, r));
    assert.ok(isLatinSquare(rotations), 'a 3-vendor board must still balance over 3 rotations');
    assert.equal(fullRotationCount(3), 3);
  });

  it('returns nothing for an empty board', () => {
    assert.deepEqual(rotationAssignment([], 0), []);
  });

  it('breaks the fixed assignment it replaces', () => {
    // The whole point: at least one rotation must move vendors off the shipped
    // seats, or rotation is not de-confounding anything.
    const rotations = Array.from({ length: 6 }, (_, r) => rotationAssignment(SIX, r));
    const matchesDefault = rotations.filter(rot =>
      rot.every(s => DEFAULT_ASSIGNMENT[s.vendor] === s.role));
    assert.ok(matchesDefault.length <= 1, 'rotations must not all reproduce the fixed assignment');

    const perplexityRoles = rotations.map(rot => rot.find(s => s.vendor === 'perplexity')!.role);
    assert.ok(
      perplexityRoles.filter(r => r === 'DEVIL').length === 1,
      "perplexity must hold the Devil's seat exactly once, not always",
    );
  });
});

describe('buildRotatedSeats', () => {
  it('carries the role mindset into the system prompt', () => {
    const seats = buildRotatedSeats(fakeConfigs(SIX), 'BASE::', 0);
    assert.equal(seats.length, 6);
    for (const seat of seats) {
      assert.ok(seat.system.startsWith('BASE::'), 'round base must be preserved');
      assert.ok(seat.system.length > 'BASE::'.length, 'a role mindset must be appended');
    }
  });

  it('moves a vendor between roles as the rotation advances', () => {
    const configs = fakeConfigs(SIX);
    const r0 = buildRotatedSeats(configs, 'B', 0);
    const r1 = buildRotatedSeats(configs, 'B', 1);
    const roleOf = (seats: any[], vendor: string) =>
      seats.find(s => s.config.name === vendor)!.role;
    assert.notEqual(roleOf(r0, 'anthropic'), roleOf(r1, 'anthropic'));
  });

  it('gives the same role the same system prompt regardless of vendor', () => {
    const configs = fakeConfigs(SIX);
    const all = Array.from({ length: 6 }, (_, r) => buildRotatedSeats(configs, 'B', r)).flat();
    const byRole = new Map<string, Set<string>>();
    for (const seat of all) {
      if (!byRole.has(seat.role)) byRole.set(seat.role, new Set());
      byRole.get(seat.role)!.add(seat.system);
    }
    for (const [role, systems] of byRole) {
      assert.equal(systems.size, 1, `role ${role} must have one prompt across every vendor`);
    }
  });
});

describe('buildControlRotationSeats', () => {
  it('seats one vendor across the same roles as the treatment arm', () => {
    const [config] = fakeConfigs(['anthropic']);
    const seats = buildControlRotationSeats(config, 'B', 6);
    assert.equal(seats.length, 6);
    assert.equal(new Set(seats.map(s => s.role)).size, 6, 'control must cover every role');
    assert.ok(seats.every(s => s.config.name === 'anthropic'), 'control is one vendor only');
  });

  it('matches the treatment arm role set exactly, so only the vendor mix differs', () => {
    const configs = fakeConfigs(SIX);
    const treatment = buildRotatedSeats(configs, 'B', 0).map(s => s.role).sort();
    const control = buildControlRotationSeats(configs[0], 'B', 6).map(s => s.role).sort();
    assert.deepEqual(control, treatment);
  });
});

describe('isLatinSquare', () => {
  it('rejects a square where one vendor repeats a role', () => {
    const bad = [
      [{ vendor: 'a', role: 'CEO' }, { vendor: 'b', role: 'COO' }],
      [{ vendor: 'a', role: 'CEO' }, { vendor: 'b', role: 'COO' }],
    ];
    assert.equal(isLatinSquare(bad), false);
  });

  it('rejects an empty set', () => {
    assert.equal(isLatinSquare([]), false);
  });

  it('accepts a valid 2x2', () => {
    const good = [
      [{ vendor: 'a', role: 'CEO' }, { vendor: 'b', role: 'COO' }],
      [{ vendor: 'a', role: 'COO' }, { vendor: 'b', role: 'CEO' }],
    ];
    assert.equal(isLatinSquare(good), true);
  });
});
