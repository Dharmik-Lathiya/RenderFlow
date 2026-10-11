import { DEFAULT_LEASE, validateLeaseConfig, workerIdForProcess } from './lease';

/**
 * Lease configuration, which is pure and fails at boot.
 *
 * This is the difference between "a worker crashed" and "two workers render the
 * same reel". A heartbeat interval at or above the lease length lets a lease
 * expire while its holder is still working; the reaper then hands a live job to
 * a second worker, and both race to capture the credits. Catching that at boot
 * is the whole point - it is not recoverable at runtime.
 */
describe('validateLeaseConfig', () => {
  const valid = { leaseSeconds: 120, heartbeatSeconds: 30, maxAttempts: 3 };

  it('accepts a sane configuration', () => {
    expect(validateLeaseConfig(valid)).toEqual(valid);
  });

  it('rejects a heartbeat longer than the lease', () => {
    expect(() => validateLeaseConfig({ ...valid, heartbeatSeconds: 200 })).toThrow(
      /HEARTBEAT_SECONDS/,
    );
  });

  it('rejects a heartbeat exactly equal to the lease', () => {
    // Not "half or less" but strictly: a heartbeat at exactly the lease length
    // can land a single tick late and lose the lease while still running.
    expect(() => validateLeaseConfig({ ...valid, heartbeatSeconds: 120 })).toThrow(
      /HEARTBEAT_SECONDS/,
    );
  });

  it('accepts a heartbeat at exactly half the lease', () => {
    expect(() => validateLeaseConfig({ ...valid, heartbeatSeconds: 60 })).not.toThrow();
  });

  it('rejects a non-positive lease', () => {
    expect(() => validateLeaseConfig({ ...valid, leaseSeconds: 0 })).toThrow(/JOB_LEASE_SECONDS/);
    expect(() => validateLeaseConfig({ ...valid, leaseSeconds: -1 })).toThrow(/JOB_LEASE_SECONDS/);
  });

  it('rejects a fractional lease', () => {
    expect(() => validateLeaseConfig({ ...valid, leaseSeconds: 12.5 })).toThrow(
      /JOB_LEASE_SECONDS/,
    );
  });

  it('rejects a non-positive heartbeat', () => {
    expect(() => validateLeaseConfig({ ...valid, heartbeatSeconds: 0 })).toThrow(
      /HEARTBEAT_SECONDS/,
    );
  });

  it('ships a configuration that satisfies its own rule', () => {
    // A default that fails its own validation would stop every worker at boot.
    expect(() => validateLeaseConfig(DEFAULT_LEASE)).not.toThrow();
  });

  it('explains what breaks, not just that something did', () => {
    expect(() => validateLeaseConfig({ ...valid, heartbeatSeconds: 200 })).toThrow(
      /still hold a valid lease/,
    );
  });
});

describe('workerIdForProcess', () => {
  it('includes the host and pid so two processes differ', () => {
    expect(workerIdForProcess('x')).toContain(String(process.pid));
  });

  it('is stable within a process, so a renewal is the same worker', () => {
    // renewLease is guarded on worker_id. An id that changed per call would
    // never extend its own lease, and the worker would abandon the job after its
    // first heartbeat - the exact failure the lease exists to prevent.
    expect(workerIdForProcess()).toBe(workerIdForProcess());
    expect(workerIdForProcess('x')).toBe(workerIdForProcess('x'));
  });

  it('is three colon-separated parts, host first', () => {
    expect(workerIdForProcess('x').split(':')).toHaveLength(3);
    expect(workerIdForProcess('x').endsWith(':x')).toBe(true);
  });

  it('uses a per-process instance id rather than the call site', () => {
    // Two containers on one host share hostname and pid namespace, so the random
    // component generated once per module load is what keeps them apart.
    const id = workerIdForProcess();
    expect(id.split(':')[2]).toHaveLength(8);
    expect(workerIdForProcess()).toBe(id);
  });
});
