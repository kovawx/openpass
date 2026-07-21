import { describe, expect, it } from 'vitest';
import { mergeSyncState, type SecretTombstone } from './syncMerge';

interface TestSecret {
  id: string;
  site: string;
  secret: string;
  createdAt: string;
  updatedAt?: string;
}

const original: TestSecret = {
  id: 'one',
  site: 'example.com',
  secret: 'ABC',
  createdAt: '2026-07-20T00:00:00.000Z'
};

describe('multi-device sync merge', () => {
  it('takes the newest update for the same record', () => {
    const remote = { ...original, site: 'new.example.com', updatedAt: '2026-07-21T00:00:00.000Z' };
    expect(mergeSyncState([original], [], [remote], []).secrets).toEqual([remote]);
  });

  it('propagates deletions instead of resurrecting an older record', () => {
    const tombstone: SecretTombstone = {
      id: 'one',
      deviceId: 'device-b',
      deletedAt: '2026-07-21T00:00:00.000Z'
    };
    const result = mergeSyncState([original], [], [], [tombstone]);
    expect(result.secrets).toEqual([]);
    expect(result.tombstones).toEqual([tombstone]);
  });

  it('allows an intentional update newer than a tombstone', () => {
    const updated = { ...original, updatedAt: '2026-07-22T00:00:00.000Z' };
    const tombstone: SecretTombstone = {
      id: 'one',
      deviceId: 'device-b',
      deletedAt: '2026-07-21T00:00:00.000Z'
    };
    expect(mergeSyncState([updated], [tombstone], [], []).secrets).toEqual([updated]);
  });

  it('deduplicates equivalent secrets created with different IDs', () => {
    const duplicate = {
      ...original,
      id: 'two',
      updatedAt: '2026-07-21T00:00:00.000Z'
    };
    expect(mergeSyncState([original], [], [duplicate], []).secrets).toEqual([duplicate]);
  });
});
