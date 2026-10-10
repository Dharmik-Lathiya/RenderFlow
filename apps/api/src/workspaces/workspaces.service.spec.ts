import { roleHas, roleSatisfies } from './workspaces.service';
import type { WorkspaceRole } from '@renderflow/common';

/**
 * The workspace role capability table.
 *
 * This is security-critical pure logic, so it is pinned here rather than only
 * exercised through HTTP: getting it wrong is silent, because the API simply lets
 * the wrong people edit or approve and every response looks normal.
 */
describe('roleHas', () => {
  it('lets every role read', () => {
    for (const role of ['OWNER', 'EDITOR', 'APPROVER', 'VIEWER'] as WorkspaceRole[]) {
      expect(roleHas(role, 'read')).toBe(true);
    }
  });

  it('separates writing from approving below OWNER', () => {
    // The whole point of having both roles: whoever wrote the caption should not
    // be the one who signs it off.
    expect(roleHas('EDITOR', 'write')).toBe(true);
    expect(roleHas('EDITOR', 'approve')).toBe(false);
    expect(roleHas('APPROVER', 'approve')).toBe(true);
    expect(roleHas('APPROVER', 'write')).toBe(false);
  });

  it('reserves administration for OWNER alone', () => {
    expect(roleHas('OWNER', 'administer')).toBe(true);
    for (const role of ['EDITOR', 'APPROVER', 'VIEWER'] as WorkspaceRole[]) {
      expect(roleHas(role, 'administer')).toBe(false);
    }
  });

  it('grants a VIEWER nothing beyond reading', () => {
    expect(roleHas('VIEWER', 'write')).toBe(false);
    expect(roleHas('VIEWER', 'approve')).toBe(false);
  });
});

describe('roleSatisfies', () => {
  it('accepts a role holding itself', () => {
    for (const role of ['OWNER', 'EDITOR', 'APPROVER', 'VIEWER'] as WorkspaceRole[]) {
      expect(roleSatisfies(role, role)).toBe(true);
    }
  });

  it('lets OWNER do everything', () => {
    for (const required of ['OWNER', 'EDITOR', 'APPROVER', 'VIEWER'] as WorkspaceRole[]) {
      expect(roleSatisfies('OWNER', required)).toBe(true);
    }
  });

  it('does not let an EDITOR approve', () => {
    // Regression guard. A linear rank (OWNER > EDITOR > APPROVER > VIEWER) would
    // pass this wrongly, which is exactly why the table is capabilities and not
    // numbers.
    expect(roleSatisfies('EDITOR', 'APPROVER')).toBe(false);
    expect(roleSatisfies('EDITOR', 'EDITOR')).toBe(true);
  });

  it('does not let an APPROVER edit', () => {
    expect(roleSatisfies('APPROVER', 'EDITOR')).toBe(false);
    expect(roleSatisfies('APPROVER', 'APPROVER')).toBe(true);
  });

  it('does not let a VIEWER write', () => {
    expect(roleSatisfies('VIEWER', 'EDITOR')).toBe(false);
    expect(roleSatisfies('VIEWER', 'APPROVER')).toBe(false);
    expect(roleSatisfies('VIEWER', 'OWNER')).toBe(false);
    expect(roleSatisfies('VIEWER', 'VIEWER')).toBe(true);
  });

  it('never lets a lesser role satisfy a greater requirement', () => {
    const pairs: Array<[WorkspaceRole, WorkspaceRole]> = [
      ['VIEWER', 'EDITOR'],
      ['VIEWER', 'OWNER'],
      ['APPROVER', 'EDITOR'],
      ['APPROVER', 'OWNER'],
      ['EDITOR', 'OWNER'],
    ];
    for (const [actual, required] of pairs) {
      expect(roleSatisfies(actual, required)).toBe(false);
    }
  });
});
