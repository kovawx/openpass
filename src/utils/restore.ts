import { normalizeVaultSecrets, type VaultSecret } from './vault';
import { mergeSyncState, getSecretTimestamp, type SecretTombstone } from './syncMerge';
import { validateBackupData, checkBackupCompatibility, decryptBackupData } from './backup';

export type RestoreMode = 'merge' | 'replace';

export async function decodeRestoreBackup(value: unknown, passwords: string[]) {
  const validation = validateBackupData<VaultSecret>(value);
  if (!validation.valid || !validation.data) throw new Error(validation.error || '备份格式无效');
  const data = validation.data;
  if (data.formatVersion > 1) throw new Error('不支持此备份格式版本');
  // 无版本号的历史数组按旧格式导入；有版本号的备份遵循兼容性检查。
  if (data.formatVersion !== 0) {
    const compatibility = checkBackupCompatibility(data.appVersion);
    if (!compatibility.compatible) throw new Error(compatibility.message);
  }
  if (!data.encrypted) return normalizeVaultSecrets(data.secrets);
  for (const password of [...new Set(passwords.filter(Boolean))]) {
    try { return normalizeVaultSecrets(await decryptBackupData(data, password)); } catch { /* 尝试历史备份密码 */ }
  }
  throw new Error('无法解密备份，请输入创建这份备份时使用的密码');
}

/** 显式恢复允许复活已删除记录，但不能回退同一 HOTP 密钥已使用的计数器。 */
export function planRestore(current: VaultSecret[], incoming: VaultSecret[], tombstones: SecretTombstone[],
  mode: RestoreMode, deviceId: string, now = Date.now()) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('恢复方式无效');
  const target = normalizeVaultSecrets(incoming);
  const effectiveTime = Math.max(now, ...current.map(getSecretTimestamp),
    ...tombstones.map((entry) => Date.parse(entry.deletedAt) || 0)) + 1;
  const updatedAt = new Date(effectiveTime).toISOString();
  const restored = target.map((entry) => {
    const counters = current.filter((record) => record.id === entry.id && record.secret === entry.secret && record.type === 'hotp')
      .map((record) => record.counter ?? 0);
    return { ...entry, updatedAt, ...(entry.type === 'hotp'
      ? { counter: Math.max(entry.counter ?? 0, ...counters) } : {}) };
  });
  const ids = new Set(restored.map((entry) => entry.id));
  const nextTombstones = tombstones.filter((entry) => !ids.has(entry.id));
  if (mode === 'replace') {
    for (const entry of current) {
      if (!ids.has(entry.id)) nextTombstones.push({ id: entry.id, deviceId, deletedAt: updatedAt });
    }
    return { secrets: restored, tombstones: nextTombstones };
  }
  return mergeSyncState(current, nextTombstones, restored, []);
}
