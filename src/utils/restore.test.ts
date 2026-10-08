import { describe, expect, it } from 'vitest';
import { planRestore } from './restore';
import { mergeSyncState } from './syncMerge';
const key = 'JBSWY3DPEHPK3PXP';
const one = { id: 'one', secret: key, site: 'example.com', updatedAt: '2026-01-01T00:00:00Z' };
const two = { ...one, id: 'two', secret: 'GEZDGNBVGY3TQOJQ' };
describe('explicit version restoration', () => {
  it('merges records without removing other current accounts', () => {
    const plan = planRestore([one, two], [{ ...one, name: 'restored' }], [], 'merge', 'device', Date.parse('2026-02-01'));
    expect(plan.secrets).toHaveLength(2);
    expect(plan.secrets.find((entry) => entry.id === 'one')?.name).toBe('restored');
  });
  it('replaces records and publishes deletions that survive another device merging', () => {
    const plan = planRestore([one, two], [one], [], 'replace', 'device', Date.parse('2026-02-01'));
    expect(plan.secrets.map((entry) => entry.id)).toEqual(['one']);
    expect(mergeSyncState(plan.secrets, plan.tombstones, [one, two], []).secrets.map((entry) => entry.id)).toEqual(['one']);
  });
  it('can restore an empty version and intentionally revive an earlier deletion', () => {
    expect(planRestore([one], [], [], 'replace', 'device').secrets).toEqual([]);
    const tombstones = [{ id: 'one', deviceId: 'other', deletedAt: '2030-01-01T00:00:00Z' }];
    const plan = planRestore([], [one], tombstones, 'merge', 'device', 0);
    expect(mergeSyncState(plan.secrets, plan.tombstones, [], tombstones).secrets).toHaveLength(1);
  });
  it('keeps the largest used HOTP counter across rollback and sync', () => {
    const hotp = { ...one, type: 'hotp' as const, counter: 20 };
    expect(planRestore([hotp], [{ ...hotp, counter: 1 }], [], 'replace', 'device').secrets[0].counter).toBe(20);
    expect(mergeSyncState([{ ...hotp, updatedAt: '2026-01-01' }], [], [{ ...hotp, counter: 1, updatedAt: '2026-02-01' }], []).secrets[0].counter).toBe(20);
  });
});
