import { describe, expect, it } from 'vitest';
import { filterAccounts, getAccountGroups, normalizeAccountOrganization, removeAccountGroup } from './accountOrganization';
import { normalizeVaultSecrets, toOtpAccount } from './vault';
import type { VaultSecret } from './vault';
import { mergeSyncState } from './syncMerge';
import { planRestore } from './restore';

const old: VaultSecret = { id: 'old', site: 'example.com', name: '旧账户', secret: 'JBSWY3DPEHPK3PXP' };
const work = { ...old, id: 'work', name: 'GitHub', site: 'github.com', group: '工作', favorite: true };
const personal = { ...old, id: 'personal', name: '邮箱', group: '个人', favorite: false };
const accounts = [old, work, personal];

describe('account groups and favorites', () => {
  it('defaults legacy records and safely normalizes imported metadata', () => {
    expect(normalizeVaultSecrets([old])[0]).toMatchObject({ ...old, group: '', favorite: false });
    expect(normalizeAccountOrganization({ group: '  工作  ', favorite: true })).toEqual({ group: '工作', favorite: true });
    const malformed = { group: 123, favorite: 'false' } as unknown as Parameters<typeof normalizeAccountOrganization>[0];
    expect(normalizeAccountOrganization(malformed)).toEqual({ group: '', favorite: false });
  });

  it('lists unique groups without changing account order or reserving filter names', () => {
    expect(getAccountGroups([...accounts, { group: ' 工作 ' }, { group: '' }])).toEqual(['个人', '工作']);
    expect(filterAccounts([{ ...work, group: '全部分组' }], { group: '全部分组' })).toHaveLength(1);
    expect(accounts[0]).toBe(old);
  });

  it('combines search, groups and favorites, including the ungrouped legacy records', () => {
    expect(filterAccounts(accounts, { group: '' })).toEqual([old]);
    expect(filterAccounts(accounts, { group: '工作', favoritesOnly: true, query: ' GITHUB ' })).toEqual([work]);
    expect(filterAccounts(accounts, { group: '个人', favoritesOnly: true })).toEqual([]);
    expect(filterAccounts(accounts, { query: '工作' })).toEqual([work]);
    expect(filterAccounts(accounts, { group: null })).toEqual(accounts);
  });

  it('retains management secret search while metadata-only views cannot search raw keys', () => {
    expect(filterAccounts(accounts, { query: old.secret })).toEqual([]);
    expect(filterAccounts(accounts, { query: old.secret }, true)).toEqual(accounts);
  });

  it('deletes a group without deleting accounts, clearing favorites or mutating its input', () => {
    const result = removeAccountGroup(accounts, '工作');
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ ...work, group: '', favorite: true });
    expect(result[0]).toBe(old);
    expect(result[2]).toBe(personal);
    expect(work.group).toBe('工作');
    expect(getAccountGroups(result)).toEqual(['个人']);
  });

  it('includes organization in everyday account metadata without exposing raw keys', () => {
    expect(toOtpAccount(work)).toMatchObject({ id: 'work', group: '工作', favorite: true });
    expect(toOtpAccount(work)).not.toHaveProperty('secret');
    expect(toOtpAccount(old)).toMatchObject({ group: '', favorite: false });
  });

  it('converges across devices after regrouping, unfavoriting and deleting a group', () => {
    const before = { ...work, updatedAt: '2026-10-10T00:00:00Z' };
    const after = { ...work, group: '', favorite: false, updatedAt: '2026-10-12T00:00:00Z' };
    expect(mergeSyncState([before], [], [after], []).secrets).toEqual([after]);
    expect(mergeSyncState([after], [], [before], []).secrets).toEqual([after]);
    expect(mergeSyncState([after], [], [after], []).changed).toBe(false);
  });

  it('restores organization with both merge and replace while older versions get defaults', () => {
    for (const mode of ['merge', 'replace'] as const) {
      const restored = planRestore([old], [work], [], mode, 'device');
      expect(restored.secrets.find((account) => account.id === work.id)).toMatchObject({ group: '工作', favorite: true });
      const legacy = planRestore([work], [old], [], mode, 'device');
      expect(legacy.secrets.find((account) => account.id === old.id)).toMatchObject({ group: '', favorite: false });
    }
  });
});
