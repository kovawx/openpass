import type { RestoreMode } from './restore';

export async function restoreBackupInManager(backupData: unknown, mode: RestoreMode, options: { confirmed?: boolean } = {}) {
  const message = mode === 'replace'
    ? '替换当前全部密钥为此版本？此版本中不存在的密钥将被删除。操作前会保存加密快照；HOTP 计数器不会回退。'
    : '合并此版本的密钥？同 ID 记录使用备份内容，其余当前记录保留。';
  if (!options.confirmed && !confirm(message)) return null;
  let result = await chrome.runtime.sendMessage({ action: 'restoreVault', backupData, mode });
  if (result?.error?.includes('无法解密备份')) {
    const password = prompt('请输入创建这份备份时使用的密码');
    if (password === null) return null;
    result = await chrome.runtime.sendMessage({ action: 'restoreVault', backupData, mode, password });
  }
  if (result?.error || !result?.success) throw new Error(result?.error || '恢复失败');
  return result as { success: true; count: number };
}
