// Role rotation, so the eval measures vendors rather than role prompts.
//
// DEFAULT_ASSIGNMENT pins each vendor to one role for the whole run: Anthropic
// is always CEO, Perplexity is always the Devil's Advocate. The Devil's mindset
// says "Do NOT hedge. Do NOT offer the upside" and "default to attack". So in a
// fixed-seat run, "Perplexity is the most contrarian vendor" is not a finding
// about Perplexity. It is a restatement of the prompt Perplexity was given, and
// vendor and role are perfectly confounded: every vendor difference is also a
// role difference, and neither can be attributed.
//
// A Latin square breaks that. Across k rotations each vendor occupies each role
// exactly once, and each role is filled by each vendor exactly once, so vendor
// effects and role effects are orthogonal by construction and can be estimated
// separately from the same runs.
//
// A cyclic square is used rather than a random one. It is balanced, it is
// reproducible without a seed, and rotation r is trivially auditable: vendor i
// sits in role (i + r) mod k.

import type { ProviderConfig } from '../provider/factory.js';
import type { Seat } from '../boardroom/panel.js';
import { ROLES, type Role } from '../boardroom/roles.js';

/** Role order defining the square. Fixed so rotations are reproducible. */
export const ROLE_ORDER = ['CEO', 'COO', 'CFO', 'CTO', 'CMO', 'DEVIL'] as const;

export interface RotationSeat {
  vendor: string;
  role: string;
}

/**
 * The vendor-to-role assignment for one rotation.
 *
 * Vendors are sorted by name so the square does not depend on the order in
 * which providers happened to be detected. Rotation 0 is the identity mapping
 * onto ROLE_ORDER, NOT the shipped DEFAULT_ASSIGNMENT: the eval needs a
 * balanced square, and starting from an arbitrary hand-tuned mapping would make
 * rotation r meaningless.
 */
export function rotationAssignment(vendors: string[], rotation: number): RotationSeat[] {
  const sorted = [...vendors].sort();
  const k = sorted.length;
  if (k === 0) return [];
  const roles = ROLE_ORDER.slice(0, k);
  const shift = ((rotation % k) + k) % k;
  return sorted.map((vendor, i) => ({
    vendor,
    role: roles[(i + shift) % roles.length],
  }));
}

/** How many rotations are needed for a full square over k vendors. */
export function fullRotationCount(vendorCount: number): number {
  return Math.max(1, Math.min(vendorCount, ROLE_ORDER.length));
}

function roleByName(name: string): Role {
  const role = ROLES[name];
  if (!role) throw new Error(`Unknown role "${name}" in rotation.`);
  return role;
}

/** Build the seats for one rotation of the multi-vendor panel. */
export function buildRotatedSeats(
  configs: ProviderConfig[],
  roundBase: string,
  rotation: number,
): Seat[] {
  const byName = new Map(configs.map(c => [c.name, c]));
  const assignment = rotationAssignment([...byName.keys()], rotation);
  return assignment.map(({ vendor, role }) => {
    const config = byName.get(vendor)!;
    const r = roleByName(role);
    return { config, role: r.name, system: roundBase + r.mindset };
  });
}

/**
 * Build seats for the single-vendor control at a given rotation.
 *
 * The control seats one vendor in all six roles, so rotation cannot change who
 * is answering. It still matters that the control covers the SAME set of roles
 * as the treatment arm, otherwise the two arms differ in their role mix as well
 * as their vendor mix and the comparison is not clean. Every rotation of the
 * control therefore fills all k roles with the one vendor.
 */
export function buildControlRotationSeats(
  config: ProviderConfig,
  roundBase: string,
  roleCount: number,
): Seat[] {
  return ROLE_ORDER.slice(0, roleCount).map(name => {
    const r = roleByName(name);
    return { config, role: r.name, system: roundBase + r.mindset };
  });
}

/**
 * Verify that a set of rotations forms a proper Latin square.
 *
 * Used by the runner to refuse to report a vendor-versus-role decomposition it
 * did not actually earn, and asserted directly in the tests.
 */
export function isLatinSquare(rotations: RotationSeat[][]): boolean {
  if (rotations.length === 0) return false;
  const k = rotations[0].length;
  if (k === 0) return false;
  if (!rotations.every(r => r.length === k)) return false;

  const vendors = [...new Set(rotations[0].map(s => s.vendor))].sort();
  if (vendors.length !== k) return false;

  // Each vendor must see each role exactly once across the rotations, and each
  // role must be held by each vendor exactly once.
  for (const vendor of vendors) {
    const roles = rotations.map(r => r.find(s => s.vendor === vendor)?.role);
    if (roles.some(r => r === undefined)) return false;
    if (new Set(roles).size !== rotations.length) return false;
  }
  for (let i = 0; i < k; i++) {
    const role = rotations[0][i].role;
    const holders = rotations.map(r => r.find(s => s.role === role)?.vendor);
    if (holders.some(v => v === undefined)) return false;
    if (new Set(holders).size !== rotations.length) return false;
  }
  return true;
}
