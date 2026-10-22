import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoBackup } from './useAutoBackup';
import type { BackupData } from '@/utils/backup';

let storedHandle: FileSystemDirectoryHandle | null;
let permission: PermissionState;
let abortWrite: boolean;
const requestPermission = vi.fn();
const getFileHandle = vi.fn();
const open = vi.fn();
const set = vi.fn();

function handle(name = 'openpass-back'): FileSystemDirectoryHandle {
  return {
    kind: 'directory', name,
    queryPermission: vi.fn(async () => permission),
    requestPermission,
    getFileHandle
  } as unknown as FileSystemDirectoryHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
  permission = 'prompt';
  abortWrite = false;
  storedHandle = handle();
  requestPermission.mockImplementation(async () => { permission = 'granted'; return permission; });
  const close = vi.fn();
  // Deliver IDB request success before transaction commit, as real IndexedDB does.
  open.mockImplementation(() => {
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => {
      Object.assign(request, { result: { close, transaction: () => {
        const transaction = {} as IDBTransaction;
        const operation = (value: unknown, write?: () => void) => {
          const result = {} as IDBRequest;
          queueMicrotask(() => {
            Object.assign(result, { result: value });
            result.onsuccess?.({} as Event);
            queueMicrotask(() => {
              if (write && abortWrite) {
                Object.assign(transaction, { error: new DOMException('fixture abort', 'AbortError') });
                transaction.onabort?.({} as Event);
              } else {
                write?.();
                transaction.oncomplete?.({} as Event);
              }
            });
          });
          return result;
        };
        Object.assign(transaction, { objectStore: () => ({
          get: () => operation(storedHandle),
          put: (next: FileSystemDirectoryHandle) => operation(undefined, () => { storedHandle = next; }),
          delete: () => operation(undefined, () => { storedHandle = null; })
        }) });
        return transaction;
      } } });
      request.onsuccess?.({} as Event);
    });
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  vi.stubGlobal('chrome', { storage: { local: { set } } });
  vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => handle('replacement')) });
});

afterEach(() => vi.unstubAllGlobals());

describe('backup directory permission recovery', () => {
  it('keeps the saved directory and requests permission in the click before any IDB wait', async () => {
    const backup = useAutoBackup();
    expect(await backup.getDirectoryInfo()).toMatchObject({ hasHandle: true, name: 'openpass-back', permission: 'prompt' });
    const reads = open.mock.calls.length;
    const recovery = backup.requestPermission();
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(open).toHaveBeenCalledTimes(reads);
    await expect(recovery).resolves.toEqual({ success: true });
    expect(window.showDirectoryPicker).not.toHaveBeenCalled();
    expect(await backup.getDirectoryInfo()).toMatchObject({ permission: 'granted' });
    expect(set).not.toHaveBeenCalled();
  });

  it('retains the original directory when the user declines recovery', async () => {
    requestPermission.mockImplementation(async () => { permission = 'denied'; return permission; });
    const backup = useAutoBackup();
    await backup.getDirectoryInfo();
    expect(await backup.requestPermission()).toMatchObject({ success: false });
    expect(await backup.getDirectoryInfo()).toMatchObject({ hasHandle: true, name: 'openpass-back', permission: 'denied' });
    expect(set).not.toHaveBeenCalled();
  });

  it('does not prompt or write files during backup while permission is pending', async () => {
    const result = await useAutoBackup().writeToDirectory({ encrypted: true } as BackupData);
    expect(result).toMatchObject({ success: false, needAuth: true });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getFileHandle).not.toHaveBeenCalled();
  });

  it('writes a directory backup after recovering permission on the original handle', async () => {
    const write = vi.fn();
    const close = vi.fn();
    getFileHandle.mockResolvedValue({ createWritable: async () => ({ write, close }) });
    const backup = useAutoBackup();
    await backup.getDirectoryInfo();
    await backup.requestPermission();
    const data = { encrypted: true, encryptedData: 'fixture-ciphertext' } as BackupData;
    expect(await backup.writeToDirectory(data)).toMatchObject({ success: true });
    expect(write).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not report a selected directory as saved when the IDB transaction aborts', async () => {
    abortWrite = true;
    const backup = useAutoBackup();
    expect(await backup.selectDirectory()).toMatchObject({ success: false, error: 'fixture abort' });
    expect(storedHandle?.name).toBe('openpass-back');
    expect(set).not.toHaveBeenCalled();
  });

  it('clears the cached handle when the saved directory is removed', async () => {
    const backup = useAutoBackup();
    await backup.getDirectoryInfo();
    await backup.removeHandle();
    expect(await backup.requestPermission()).toMatchObject({ success: false, error: '未选择备份目录' });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
