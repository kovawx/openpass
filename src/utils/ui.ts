/**
 * 通用 UI 工具模块
 */

/**
 * 显示 Toast 提示
 */
export function showToast(message: string, type: 'success' | 'error' | 'warning' | 'default' = 'default') {
  const oldToast = document.querySelector('.openpass-toast');
  if (oldToast) oldToast.remove();

  const toast = document.createElement('div');
  toast.className = `openpass-toast openpass-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('openpass-toast-show');
  });

  setTimeout(() => {
    toast.classList.remove('openpass-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * 显示确认对话框
 */
export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    resolve(confirm(message));
  });
}

/**
 * 站点域名解析与匹配统一在 domainMatch 模块，请直接从 '@/utils/domainMatch' 导入。
 * （曾经的 re-export 会触发 WXT 自动导入的 duplicated imports 警告，已移除。）
 */

/**
 * 安全发送消息到扩展
 */
export async function safeSendMessage<TMessage, TResponse = unknown>(message: TMessage): Promise<TResponse | null> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    return response as TResponse;
  } catch (error) {
    if ((error as Error).message?.includes('Extension context invalidated')) {
      showToast('扩展已更新，请刷新页面', 'warning');
      return null;
    }
    throw error;
  }
}

/**
 * 格式化日期时间
 */
export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * 生成唯一 ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}
