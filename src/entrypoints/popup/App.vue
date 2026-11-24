<script setup lang="ts">
import { defineAsyncComponent, ref, computed, onMounted, onUnmounted } from 'vue';
import TOTP from '@/utils/totp';
import { toOtpAccount, type OtpAccount } from '@/utils/vault';
import { decryptSessionData, getValidSessionKey } from '@/utils/session';
import { DAILY_WRITE_SETUP_MESSAGE } from '@/utils/deviceVaultWrite';
import { useAuthStore } from '@/stores/auth';
import { normalizeOtpSettings, type OtpSettings } from '@/utils/otp';
import { parseUrl } from '@/utils/domainMatch';
import { showToast } from '@/utils/ui';
import type { Secret } from '@/stores/secrets';
import { getAccountGroups, removeAccountGroup } from '@/utils/accountOrganization';
import { isMigrationLink, parseOtpMigration } from '@/utils/otpMigration';
import { clipboardImages, decodeQrBlob, readQrImageUrl } from '@/utils/qrBlob';
import { classifyOtpQrInput, DEVICE_REGISTRATION_MESSAGE, isDeviceRegistration } from '@/utils/otpQrInput';
import type { AuthenticatorImport } from '@/utils/authenticatorImport';

import PopupHeader from '@/components/popup/PopupHeader.vue';
import PopupHomePage from '@/components/popup/PopupHomePage.vue';
import PopupSecretForm from '@/components/popup/PopupSecretForm.vue';
import PopupAboutModal from '@/components/popup/PopupAboutModal.vue';
import PopupRepairModal from '@/components/popup/PopupRepairModal.vue';
import PopupSetupPrompt from '@/components/popup/PopupSetupPrompt.vue';

const AuthenticatorImportDialog = defineAsyncComponent(() => import('@/components/manager/AuthenticatorImport.vue'));

interface PendingSecret extends OtpSettings {
  secret: string;
  site: string;
  name: string;
  digits?: number;
  group?: string;
}

interface CodeEntry {
  code: string;
  remainingSeconds: number;
  expiresAt: number | null;
}

type PreviewCode = Pick<CodeEntry, 'code' | 'expiresAt'> & { id: string };
interface PopupAccountsResult {
  locked?: boolean;
  otpAvailable?: boolean;
  message?: string;
  error?: string;
  secrets?: Array<Secret | OtpAccount>;
  codes?: PreviewCode[];
}

type TimerHandle = ReturnType<typeof setInterval>;
type Page = 'home' | 'create' | 'edit';

interface FormPayload extends OtpSettings {
  secret: string;
  site: string;
  name: string;
  digits: number;
  group?: string;
}

// 基础状态
const authStore = useAuthStore();
let authInit: Promise<void> | undefined;
const locked = ref(true);
const managementLocked = ref(true);
const accounts = ref<OtpAccount[]>([]);
const otpAccessMessage = ref('');
const unlockPassword = ref('');
const unlockError = ref('');
const unlocking = ref(false);
const creating = ref(false);
const pendingCreate = ref<FormPayload | null>(null);
const quickAdding = ref(false);
const importLinks = ref<string | null>(null);
const confirmedImport = ref<AuthenticatorImport | null>(null);
const unlockImport = ref(false);
const resumeImport = ref(false);
let quickAddRevision = 0;
let seenImportDraft = 0;
const dailyUnlockMessage = ref('');
const secrets = ref<Secret[]>([]);
let savedState = '[]';
let editingState = '[]';
const currentPage = ref<Page>('home');
const currentUrl = ref('');
const pendingSecret = ref<PendingSecret | null>(null);
const draftCreatedAt = ref(0);
let sharedQrPreview = false;
const editingSecret = ref<Secret | null>(null);
const groups = computed(() => getAccountGroups(accounts.value));
const organizing = ref(false);

// 弹窗 / 引导
const showAboutModal = ref(false);
const showRepairModal = ref(false);
const repairError = ref('');
const version = ref('');
const isSetupComplete = ref(false);
const initializing = ref(true);
let reloadRevision = 0;

// 验证码计时（统一在 App 维护，供 HomePage 渲染）
const codeData = ref<Map<string, CodeEntry>>(new Map());
let codeTimer: TimerHandle | undefined;
let codeRevision = 0;
let codeRequestInFlight = false;
let visibleAccounts: OtpAccount[] = [];
onMounted(async () => {
  version.value = chrome.runtime.getManifest().version;
  document.addEventListener('paste', handlePopupPaste);
  const activeUrl = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    currentUrl.value = tab?.url || '';
  }, () => { currentUrl.value = ''; });
  try {
    const [setup] = await Promise.all([chrome.storage.local.get(['isSetupComplete']), activeUrl]);
    isSetupComplete.value = setup.isSetupComplete === true;
    chrome.storage.onChanged.addListener(storageChangeListener);
    await reloadVault();
  } finally {
    initializing.value = false;
  }
});

onUnmounted(() => {
  quickAddRevision++;
  reloadRevision++;
  clearAllTimers();
  document.removeEventListener('paste', handlePopupPaste);
  chrome.storage.onChanged.removeListener(storageChangeListener);
});

async function reloadVault() {
  if (!isSetupComplete.value) return;
  const revision = ++reloadRevision;
  const accountRequest: Promise<PopupAccountsResult> = chrome.runtime.sendMessage({ action: 'getPopupAccounts', url: currentUrl.value })
    .catch((error: Error) => ({ error: error.message }));
  const [key, { pendingQrDraft, pendingOtpImport }] = await Promise.all([
    getValidSessionKey(),
    chrome.storage.session.get<{
      pendingQrDraft?: { secret: PendingSecret; createdAt: number; sourceUrl: string }
      pendingOtpImport?: { links: string; createdAt: number }
    }>(['pendingQrDraft', 'pendingOtpImport'])
  ]);
  if (revision !== reloadRevision) return;
  managementLocked.value = !key;
  if (pendingOtpImport && Date.now() - pendingOtpImport.createdAt < 15 * 60 * 1000) {
    if (seenImportDraft !== pendingOtpImport.createdAt) {
      seenImportDraft = pendingOtpImport.createdAt;
      openAuthenticatorImport(pendingOtpImport.links);
    }
  } else if (pendingOtpImport) {
    await chrome.storage.session.remove(['pendingOtpImport']);
  }
  if (pendingQrDraft && Number.isFinite(pendingQrDraft.createdAt) &&
      Date.now() - pendingQrDraft.createdAt < 15 * 60 * 1000) {
    if (!sharedQrPreview || pendingQrDraft.createdAt >= draftCreatedAt.value) {
      sharedQrPreview = false;
      pendingSecret.value = pendingQrDraft.secret; draftCreatedAt.value = pendingQrDraft.createdAt;
      currentPage.value = 'create';
      locked.value = false;
    }
  } else if (!sharedQrPreview && (pendingQrDraft || (!key && pendingSecret.value))) {
    if (pendingQrDraft) await chrome.storage.session.remove(['pendingQrDraft']);
    pendingSecret.value = null;
    pendingCreate.value = null; dailyUnlockMessage.value = '';
    if (currentPage.value === 'create') currentPage.value = 'home';
  }
  const result = await accountRequest;
  if (revision !== reloadRevision) return;
  if (result?.error && key && await getValidSessionKey() !== key) {
    if (revision === reloadRevision) await reloadVault();
    return;
  }
  if (revision !== reloadRevision) return;
  const records = Array.isArray(result?.secrets) ? result.secrets : [];
  managementLocked.value = result?.locked !== false || !key;
  codeRevision++;
  codeData.value.clear();
  applyPreviewCodes(result?.codes ?? []);
  accounts.value = records.map(toOtpAccount);
  if (managementLocked.value || !key) {
    secrets.value = [];
    editingSecret.value = null;
    if (currentPage.value === 'edit') currentPage.value = 'home';
    locked.value = !result?.otpAvailable && !pendingSecret.value;
    otpAccessMessage.value = result?.message || result?.error || '';
    showRepairModal.value = false;
    return;
  }
  locked.value = false;
  try {
    if (result.error) throw new Error(result.error);
    secrets.value = records as Secret[];
    savedState = JSON.stringify(secrets.value);
    const data = await chrome.storage.session.get<{ pendingSecret?: PendingSecret }>(['pendingSecret']);
    const legacy = await chrome.storage.local.get<{ encryptedPendingSecret?: string }>(['encryptedPendingSecret']);
    const pending = data.pendingSecret || (legacy.encryptedPendingSecret
      ? JSON.parse(await decryptSessionData(legacy.encryptedPendingSecret, key)) : null);
    if (revision !== reloadRevision) return;
    if (pending) {
      pendingSecret.value = pending; currentPage.value = 'create';
      await chrome.storage.session.remove(['pendingSecret']);
      await chrome.storage.local.remove(['encryptedPendingSecret']);
    }
    showRepairModal.value = false;
  } catch (error) {
    if (revision !== reloadRevision) return;
    if (await getValidSessionKey() !== key) { await reloadVault(); return; }
    secrets.value = []; accounts.value = []; clearAllTimers();
    repairError.value = (error as Error).message; showRepairModal.value = true;
  }
}

async function unlock() {
  unlocking.value = true; unlockError.value = '';
  try {
    await (authInit ??= authStore.init());
    if (!await authStore.login(unlockPassword.value)) {
      unlockError.value = authStore.isLocked() ? '尝试次数过多，请稍后重试' : '主密码错误，或密钥库无法通过校验';
      return;
    }
    unlockPassword.value = '';
    const account = pendingCreate.value;
    pendingCreate.value = null; dailyUnlockMessage.value = '';
    await reloadVault();
    if (unlockImport.value) {
      unlockImport.value = false;
      resumeImport.value = true;
    }
    if (account) await handleCreateSubmit(account);
  } catch (error) { unlockError.value = (error as Error).message; }
  finally { unlocking.value = false; }
}

function storageChangeListener(changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) {
  if (unlocking.value) return;
  if ((area === 'local' && (changes.encryptedSecrets || changes.deviceOtpEnabled || changes.encryptedDeviceOtpSecrets)) ||
      (area === 'session' && changes.sessionKey)) void reloadVault();
}

async function persistSecrets(nextSecrets: Secret[], expectedState = savedState) {
  const result = await chrome.runtime.sendMessage({ action: 'saveVault', expectedSecrets: expectedState, secrets: nextSecrets.map((secret) => ({ ...secret })), triggerSnapshot: true });
  if (result?.error || !result?.success) throw new Error(result?.error || '保存失败');
  secrets.value = result.secrets; savedState = JSON.stringify(result.secrets);
  accounts.value = secrets.value.map(toOtpAccount);
}

function getDefaultSite() {
  const urlInfo = currentUrl.value ? parseUrl(currentUrl.value) : null;
  return urlInfo?.fullUrl ?? '';
}

async function refreshCodes() {
  const ids: string[] = [];
  const now = Date.now();
  for (const account of visibleAccounts) {
    const entry = codeData.value.get(account.id);
    if (entry) {
      if (entry.expiresAt === null) continue;
      if (entry.expiresAt > now) {
        entry.remainingSeconds = Math.ceil((entry.expiresAt - now) / 1000);
        continue;
      }
      codeData.value.delete(account.id);
    }
    ids.push(account.id);
  }
  if (!ids.length || codeRequestInFlight) return;

  const revision = codeRevision;
  codeRequestInFlight = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'previewAccountCodes', ids });
    if (revision !== codeRevision || !Array.isArray(result?.codes)) return;
    applyPreviewCodes(result.codes);
  } catch { /* The next tick retries previews without blocking navigation. */ }
  finally {
    codeRequestInFlight = false;
    if (revision !== codeRevision && codeTimer !== undefined) void refreshCodes();
  }
}

function applyPreviewCodes(codes: PreviewCode[]) {
  for (const { id, code, expiresAt } of codes) {
    const remainingSeconds = expiresAt === null ? 0 : Math.ceil((expiresAt - Date.now()) / 1000);
    if (expiresAt === null || remainingSeconds > 0) codeData.value.set(id, { code, expiresAt, remainingSeconds });
  }
}

function clearAllTimers() {
  codeRevision++;
  clearInterval(codeTimer);
  codeTimer = undefined;
  visibleAccounts = [];
  codeData.value.clear();
}

function updateVisibleAccounts(next: OtpAccount[]) {
  visibleAccounts = next;
  codeRevision++;
  clearInterval(codeTimer);
  codeTimer = undefined;
  const visibleIds = new Set(next.map(account => account.id));
  for (const id of codeData.value.keys()) if (!visibleIds.has(id)) codeData.value.delete(id);
  if (currentPage.value !== 'home' || !next.length) return;
  codeTimer = setInterval(refreshCodes, 1000);
  void refreshCodes();
}

// 由后台校验版本并写入加密存储。
async function saveSecrets(expectedState = savedState) {
  if (!Array.isArray(secrets.value)) return;
  try { await persistSecrets(secrets.value, expectedState); return true; }
  catch (error) { await reloadVault(); showToast((error as Error).message, 'error'); return false; }
}

// 导航
function showHomePage() {
  quickAddRevision++;
  editingSecret.value = null;
  sharedQrPreview = false;
  pendingSecret.value = null;
  draftCreatedAt.value = 0;
  currentPage.value = 'home';
  void chrome.storage.session.remove(['pendingQrDraft', 'pendingSecret']);
}

function openCreatePage() {
  if (quickAdding.value) return;
  sharedQrPreview = false;
  pendingSecret.value = null;
  draftCreatedAt.value = 0;
  editingSecret.value = null;
  currentPage.value = 'create';
  clearAllTimers();
}

async function scanCurrentPage() {
  if (quickAdding.value) return;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'startQrElementPicker' });
    if (result?.error || !result?.success) throw new Error(result?.error || '无法在当前网页启动二维码点选');
  } catch (error) {
    showToast((error as Error).message, 'error');
    console.error('OpenPass: 启动二维码点选失败', error);
    return;
  }
  window.close();
}

function showEditPage(account: OtpAccount) {
  quickAddRevision++;
  if (managementLocked.value) { openOptionsPage(); return; }
  const secret = secrets.value.find((entry) => entry.id === account.id);
  if (!secret) return;
  editingState = savedState;
  editingSecret.value = { ...secret };
  currentPage.value = 'edit';
  clearAllTimers();
}

function handlePopupPaste(event: ClipboardEvent) {
  const clipboard = event.clipboardData;
  if (!clipboard || event.defaultPrevented || !isSetupComplete.value || currentPage.value === 'edit' ||
      pendingCreate.value || importLinks.value !== null || unlocking.value || creating.value) return;
  const text = clipboard.getData('text/plain').trim() || clipboard.getData('text/uri-list').trim();
  const images = clipboardImages(clipboard);
  const isQuickAddField = (event.target as HTMLElement | null)?.id === 'popup-quick-add';
  if (!images.length && !/^(?:otpauth(?:-migration)?:\/\/|data:image\/)/i.test(text) && !isDeviceRegistration(text) && !isQuickAddField) return;
  if (!images.length && !text) return;
  event.preventDefault();
  void quickAdd(images.length ? images : text);
}

async function quickAdd(input: string | File[]) {
  if (quickAdding.value || creating.value) return;
  quickAdding.value = true;
  const revision = ++quickAddRevision;
  try {
    let text: string;
    if (typeof input === 'string' && isDeviceRegistration(input)) throw new Error(DEVICE_REGISTRATION_MESSAGE);
    if (typeof input === 'string' && !/^(?:https?:\/\/|data:image\/)/i.test(input.trim())) {
      text = input.trim();
    } else {
      const images = typeof input === 'string' ? [await readQrImageUrl(input.trim())] : input;
      const decoded: string[] = [];
      for (const image of images) {
        const value = await decodeQrBlob(image, raw => classifyOtpQrInput(raw) ? raw : null);
        if (!value) throw new Error('未识别到验证器二维码，请粘贴清晰的二维码图片');
        decoded.push(value);
      }
      text = decoded.join('\n');
    }
    if (revision !== quickAddRevision) return;
    if (isDeviceRegistration(text)) throw new Error(DEVICE_REGISTRATION_MESSAGE);
    if (text.startsWith('{') || /\s+otpauth(?:-migration)?:\/\//i.test(text)) {
      openAuthenticatorImport(text);
      return;
    }

    let parsed = TOTP.parseOTPAuthUrl(text);
    if (isMigrationLink(text)) {
      const { accounts, missingImages } = parseOtpMigration(text);
      if (missingImages || accounts.length !== 1) {
        openAuthenticatorImport(text);
        return;
      }
      parsed = accounts[0];
    }
    if (!parsed || !TOTP.isValidSecret(parsed.secret)) throw new Error('未识别到有效的验证器链接或密钥');
    // Clipboard content may come from another site. Only use the active site when its name matches the issuer.
    const page = /^https?:\/\//i.test(currentUrl.value) ? parseUrl(currentUrl.value) : null;
    const issuer = parsed.site;
    const site = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(issuer) ? issuer
      : page?.mainDomain.split('.')[0] === issuer ? page.mainDomain : '';
    await chrome.storage.session.remove(['pendingQrDraft']);
    if (revision !== quickAddRevision) return;
    const secret = { ...parsed, site };
    const createdAt = Date.now();
    sharedQrPreview = true;
    pendingSecret.value = secret;
    draftCreatedAt.value = createdAt;
    currentPage.value = 'create';
    locked.value = false;
    clearAllTimers();
  } catch (error) {
    if (revision === quickAddRevision) showToast((error as Error).message, 'error');
  } finally { quickAdding.value = false; }
}

function openAuthenticatorImport(links = '') {
  importLinks.value = links;
  confirmedImport.value = null;
  resumeImport.value = false;
}

function requestImportUnlock(preview: AuthenticatorImport) {
  confirmedImport.value = preview;
  unlockImport.value = true;
  unlockError.value = '';
}

function closeImport() {
  importLinks.value = null;
  confirmedImport.value = null;
  resumeImport.value = false;
  void chrome.storage.session.remove(['pendingOtpImport']);
}

const createInitial = computed<FormPayload>(() => {
  if (pendingSecret.value) {
    return {
      secret: pendingSecret.value.secret,
      site: pendingSecret.value.site,
      name: pendingSecret.value.name,
      group: pendingSecret.value.group || '',
      ...normalizeOtpSettings(pendingSecret.value)
    };
  }
  return { secret: '', site: getDefaultSite(), name: '', ...normalizeOtpSettings({}) };
});

const editInitial = computed<FormPayload>(() => ({
  secret: editingSecret.value?.secret ?? '',
  site: editingSecret.value?.site ?? '',
  name: editingSecret.value?.name ?? '',
  group: editingSecret.value?.group ?? '',
  ...normalizeOtpSettings(editingSecret.value || {})
}));

// 创建 / 编辑 / 删除
async function handleCreateSubmit(data: FormPayload) {
  if (creating.value) return;
  creating.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'appendAccount', account: { ...data } });
    if (result?.error || !result?.success) throw new Error(result?.error || '保存失败');
    pendingSecret.value = null;
    await reloadVault();
    showHomePage();
    showToast(result.warning || '密钥已保存，可复制验证码回到原网页完成验证', result.warning ? 'warning' : 'success');
  } catch (error) {
    const message = (error as Error).message;
    if (message === DAILY_WRITE_SETUP_MESSAGE || message.includes('完成验证码免密初始化') ||
        message.includes('初始化独立密码备份') || message.includes('免密已关闭')) {
      pendingSecret.value = { ...data };
      pendingCreate.value = { ...data }; dailyUnlockMessage.value = message;
      try {
        await chrome.storage.session.set({ pendingQrDraft: { secret: { ...data }, createdAt: Date.now(), sourceUrl: currentUrl.value } });
      } catch { showToast('新增账户未能暂存，请保持当前弹窗打开', 'warning'); }
    } else showToast(message, 'error');
  } finally { creating.value = false; }
}

async function handleEditSubmit(data: FormPayload) {
  if (!editingSecret.value) return;
  if (!Array.isArray(secrets.value)) {
    secrets.value = [];
  }

  const index = secrets.value.findIndex(s => s.id === editingSecret.value!.id);
  if (index !== -1) {
    secrets.value[index] = {
      ...secrets.value[index],
      secret: data.secret,
      ...normalizeOtpSettings(data),
      site: data.site.toLowerCase(),
      name: data.name,
      group: data.group || '',
      updatedAt: new Date().toISOString()
    };
    if (!await saveSecrets(editingState)) return;
    showToast('密钥已更新', 'success');
    showHomePage();
  }
}

async function handleDeleteFromEdit() {
  if (!editingSecret.value) return;
  const name = editingSecret.value.name || editingSecret.value.site;
  if (!confirm(`确定要删除 "${name}" 吗？`)) {
    return;
  }

  const id = editingSecret.value.id;
  secrets.value = Array.isArray(secrets.value) ? secrets.value.filter(s => s.id !== id) : [];
  if (!await saveSecrets(editingState)) return;
  showToast('密钥已删除', 'success');
  showHomePage();
}

async function deleteSecretFromList(secret: OtpAccount) {
  if (managementLocked.value) { openOptionsPage(); return; }
  const name = secret.name || secret.site;
  if (!confirm(`确定要删除 "${name}" 吗？`)) {
    return;
  }

  secrets.value = Array.isArray(secrets.value)
    ? secrets.value.filter(item => item.id !== secret.id)
    : [];
  if (!await saveSecrets()) return;
  showToast('密钥已删除', 'success');
}

async function toggleFavorite(account: OtpAccount) {
  if (managementLocked.value) { openOptionsPage(); return; }
  if (organizing.value) return;
  organizing.value = true;
  try {
    const next = secrets.value.map((secret) => secret.id === account.id
      ? { ...secret, favorite: secret.favorite !== true } : secret);
    await persistSecrets(next);
  } catch (error) { await reloadVault(); showToast((error as Error).message, 'error'); }
  finally { organizing.value = false; }
}

async function deleteGroup(group: string) {
  if (managementLocked.value) { openOptionsPage(); return; }
  if (organizing.value || !confirm(`删除分组“${group}”？组内账户将保留并移至未分组。`)) return;
  organizing.value = true;
  try {
    await persistSecrets(removeAccountGroup(secrets.value, group));
    showToast('分组已删除，账户已保留', 'success');
  } catch (error) { await reloadVault(); showToast((error as Error).message, 'error'); }
  finally { organizing.value = false; }
}

async function copyCode(secret: OtpAccount) {
  try {
    const result = await TOTP.generateCode(secret, 6, {}, true);
    await TOTP.copyToClipboard(result.code);
    showToast('验证码已复制', 'success');
  } catch (error) { showToast((error as Error).message, 'error'); }
}

// 点击名称 / 站点跳转（与 manager 行为一致）
function openSite(secret: OtpAccount) {
  const trimmed = (secret.site || '').trim();
  if (!trimmed) return;
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  chrome.tabs.create({ url });
  window.close();
}

// 外部页面 / 退出
function openManagerForRepair() {
  showRepairModal.value = false;
  openOptionsPage();
}

function openOptionsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  window.close();
}

function openSetupPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  window.close();
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0 bg-gray-50 text-gray-900">
    <!-- 未设置引导 -->
    <div v-if="initializing && currentPage === 'home' && importLinks === null" class="px-4 py-3">
      <h1 class="text-base font-semibold text-gray-900">OpenPass</h1>
      <p class="mt-5 px-1 text-sm text-gray-500" role="status">正在读取账户…</p>
    </div>
    <PopupSetupPrompt v-else-if="!isSetupComplete" @setup="openSetupPage" />

    <form v-else-if="locked || pendingCreate || unlockImport" class="flex flex-col gap-4 p-6" @submit.prevent="unlock">
      <h2 class="text-lg font-semibold">解锁 OpenPass</h2>
      <p v-if="unlockImport" class="text-sm text-gray-500">解锁后会在当前窗口导入这批账户。</p>
      <p v-if="dailyUnlockMessage" class="text-sm text-gray-500">{{ dailyUnlockMessage }}。当前网页和新增账户会保留，解锁后自动继续保存。</p>
      <p v-if="otpAccessMessage" class="text-sm text-gray-500">{{ otpAccessMessage }}</p>
      <input v-model="unlockPassword" type="password" class="input" autocomplete="current-password" placeholder="主密码" required>
      <p v-if="unlockError" class="text-red-600">{{ unlockError }}</p>
      <button class="btn-primary" :disabled="unlocking">{{ unlocking ? '解锁中…' : '解锁' }}</button>
      <button v-if="unlockImport" type="button" class="btn-secondary" :disabled="unlocking" @click="unlockImport = false; unlockPassword = ''; unlockError = ''">返回导入</button>
      <button v-else-if="pendingCreate" type="button" class="btn-secondary" @click="pendingCreate = null; dailyUnlockMessage = ''; unlockPassword = ''; unlockError = ''">返回添加</button>
      <button v-else type="button" class="btn-secondary" @click="openOptionsPage">打开管理页面</button>
    </form>
    <template v-else>
      <PopupHeader
        @add="openCreatePage"
        @scan="scanCurrentPage"
        @about="showAboutModal = true"
        @manage="openOptionsPage"
      />

      <main class="flex-1 min-h-0 p-3" :class="currentPage === 'home' ? 'overflow-y-auto' : 'overflow-hidden'">
        <PopupHomePage
          v-if="currentPage === 'home'"
          :secrets="accounts"
          :code-data="codeData"
          :current-url="currentUrl"
          :organizing="organizing"
          @add="openCreatePage"
          @scan="scanCurrentPage"
          @copy="copyCode"
          @edit="showEditPage"
          @delete="deleteSecretFromList"
          @open-site="openSite"
          @favorite="toggleFavorite"
          @delete-group="deleteGroup"
          @visible-accounts="updateVisibleAccounts"
        />

        <PopupSecretForm
          v-else-if="currentPage === 'create'"
          :key="draftCreatedAt"
          mode="create"
          :initial="createInitial"
          :groups="groups"
          :saving="creating"
          :reading-qr="quickAdding"
          :prefilled="!!pendingSecret"
          @submit="handleCreateSubmit"
          @quick-add="quickAdd"
          @import-backup="openAuthenticatorImport()"
          @back="showHomePage"
        />

        <PopupSecretForm
          v-else-if="currentPage === 'edit'"
          mode="edit"
          :initial="editInitial"
          :groups="groups"
          @submit="handleEditSubmit"
          @back="showHomePage"
          @delete="handleDeleteFromEdit"
        />
      </main>
    </template>

    <AuthenticatorImportDialog
      v-if="importLinks !== null && !unlockImport"
      :initial-links="importLinks"
      :initial-preview="confirmedImport ?? undefined"
      :needs-unlock="managementLocked"
      :submit-on-mount="resumeImport"
      @request-unlock="requestImportUnlock"
      @close="closeImport"
    />

    <PopupAboutModal :open="showAboutModal" :version="version" @close="showAboutModal = false" />
    <PopupRepairModal
      :open="showRepairModal"
      :message="repairError"
      @close="showRepairModal = false"
      @repair="openManagerForRepair"
    />
  </div>
</template>

<style>
/* popup 尺寸约束 + 抵消共享 CSS 里非预期的 body padding（独立于 options 的全屏布局） */
html,
body {
  width: 360px;
  height: 560px;
  margin: 0;
  padding: 0;
}

#app {
  height: min(560px, 100dvh);
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

.openpass-toast {
  pointer-events: none;
}
</style>
