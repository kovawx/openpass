import { describe, expect, it } from 'vitest';
import { mergeSyncState, type SecretTombstone } from './syncMerge';
import { matchSecrets } from './domainMatch';

interface TestSecret {
  id: string;
  site: string;
  secret: string;
  createdAt: string;
  duplicateOf?: string;
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

  it('keeps explicitly retained copies matched to the site across repeated device syncs', () => {
    const retained = {
      ...original,
      id: 'retained',
      duplicateOf: original.id,
      importedAt: '2026-07-22T00:00:00.000Z'
    };
    const deviceA = mergeSyncState([original, retained], [], [original], []);
    const deviceB = mergeSyncState([original], [], deviceA.secrets, deviceA.tombstones);
    const syncedAgain = mergeSyncState(deviceA.secrets, [], deviceB.secrets, []);

    expect(deviceA.secrets).toEqual([original, retained]);
    expect(deviceB.secrets).toEqual(deviceA.secrets);
    expect(syncedAgain.changed).toBe(false);
    expect(matchSecrets('https://login.example.com', syncedAgain.secrets)).toEqual([
      original,
      retained
    ]);
  });

  it('propagates deletion of a retained copy without deleting its original', () => {
    const retained = { ...original, id: 'retained', duplicateOf: original.id };
    const tombstone: SecretTombstone = {
      id: retained.id,
      deviceId: 'device-b',
      deletedAt: '2026-07-23T00:00:00.000Z'
    };

    const result = mergeSyncState([original, retained], [], [original], [tombstone]);
    expect(result.secrets).toEqual([original]);
    expect(result.tombstones).toEqual([tombstone]);
  });
});
