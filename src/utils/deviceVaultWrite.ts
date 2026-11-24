import CryptoUtils, { type VaultKey } from './crypto';

const DATABASE = 'OpenPassDailyWriteDB';
const STORE = 'keys';
export const DAILY_WRITE_SETUP_MESSAGE = '请先解锁一次以初始化免密添加，之后新增账户无需重复验证';

function keyId(ciphertext: string) {
  const { salt, vaultFormat } = CryptoUtils.readCiphertext(ciphertext);
  return (vaultFormat ? 'v2:' : '') + CryptoUtils.arrayBufferToBase64(salt.buffer);
}

async function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Persist non-extractable, encrypt-only CryptoKeys. No password or exportable
// AES key is retained. Their salt keeps the existing portable backup format.
export async function prepareDailyWriteKeys(entries: Array<{ ciphertext: string; password: string; vaultKey?: VaultKey }>) {
  const keys = await Promise.all(entries.map(async entry => ({
    id: keyId(entry.ciphertext),
    key: await prepareKey(entry)
  })));
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      for (const entry of keys) transaction.objectStore(STORE).put(entry.key, entry.id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('保存免密添加能力失败'));
    });
  } finally { db.close(); }
}

async function prepareKey({ ciphertext, password, vaultKey }: { ciphertext: string; password: string; vaultKey?: VaultKey }) {
  const { salt, vaultFormat } = CryptoUtils.readCiphertext(ciphertext);
  if (!vaultFormat) return CryptoUtils.deriveKey(password, salt, ['encrypt']);
  const derived = vaultKey ?? await CryptoUtils.deriveVaultKey(password, CryptoUtils.arrayBufferToBase64(salt.buffer));
  if (!CryptoUtils.matchesVaultKey(ciphertext, derived)) throw new Error('密钥库已变更，请重新解锁');
  return CryptoUtils.importVaultKey(derived, ['encrypt']);
}

async function getDailyWriteKey(ciphertext: string): Promise<CryptoKey | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE);
      const request = transaction.objectStore(STORE).get(keyId(ciphertext));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function hasDailyWriteKey(ciphertext: string) {
  return !!await getDailyWriteKey(ciphertext);
}

export async function encryptDailyVault(plaintext: string, currentCiphertext: string) {
  const key = await getDailyWriteKey(currentCiphertext);
  if (!key) throw new Error(DAILY_WRITE_SETUP_MESSAGE);
  if (key.extractable || key.usages.length !== 1 || key.usages[0] !== 'encrypt') throw new Error('免密添加能力无效');
  const { salt, vaultFormat } = CryptoUtils.readCiphertext(currentCiphertext);
  return CryptoUtils.seal(plaintext, key, salt, vaultFormat);
}

// Run after the atomic vault commit, so failed commits retain their old keys.
export async function retainDailyWriteKeys(ciphertexts: string[]) {
  const keep = new Set(ciphertexts.map(keyId));
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const request = transaction.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!keep.has(String(cursor.key))) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
