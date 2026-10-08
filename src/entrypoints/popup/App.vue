<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import TOTP from '@/utils/totp';
import CryptoUtils from '@/utils/crypto';
import { readVault, toOtpAccount, type OtpAccount } from '@/utils/vault';
import { getValidSessionKey } from '@/utils/session';
import { useAuthStore } from '@/stores/auth';
import { normalizeOtpSettings, type OtpSettings } from '@/utils/otp';
import { parseUrl } from '@/utils/domainMatch';
import { showToast } from '@/utils/ui';
import type { Secret } from '@/stores/secrets';

import PopupHeader from '@/components/popup/PopupHeader.vue';
import PopupHomePage from '@/components/popup/PopupHomePage.vue';
import PopupSecretForm from '@/components/popup/PopupSecretForm.vue';
import PopupAboutModal from '@/components/popup/PopupAboutModal.vue';
import PopupRepairModal from '@/components/popup/PopupRepairModal.vue';
import PopupSetupPrompt from '@/components/popup/PopupSetupPrompt.vue';

interface PendingSecret extends OtpSettings {
  secret: string;
  site: string;
  name: string;
  digits?: number;
}

interface CodeEntry {
  code: string;
  remainingSeconds: number;
}

type TimerHandle = ReturnType<typeof setInterval>;
type Page = 'home' | 'create' | 'edit';

interface FormPayload extends OtpSettings {
  secret: string;
  site: string;
  name: string;
  digits: number;
}

// 基础状态
const authStore = useAuthStore();
const locked = ref(true);
const managementLocked = ref(true);
const accounts = ref<OtpAccount[]>([]);
const otpAccessMessage = ref('');
const unlockPassword = ref('');
const unlockError = ref('');
const unlocking = ref(false);
const secrets = ref<Secret[]>([]);
let savedState = '[]';
let editingState = '[]';
const currentPage = ref<Page>('home');
const currentUrl = ref('');
const pendingSecret = ref<PendingSecret | null>(null);
const editingSecret = ref<Secret | null>(null);

// 弹窗 / 引导
const showAboutModal = ref(false);
const showRepairModal = ref(false);
const repairError = ref('');
const version = ref('');
const isSetupComplete = ref(false);

// 验证码计时（统一在 App 维护，供 HomePage 渲染）
const codeData = ref<Map<string, CodeEntry>>(new Map());
const timers = ref<Map<string, TimerHandle>>(new Map());
onMounted(async () => {
  version.value = chrome.runtime.getManifest().version;
  const setup = await chrome.storage.local.get(['isSetupComplete']);
  isSetupComplete.value = setup.isSetupComplete === true;
  await authStore.init();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl.value = tab?.url || '';
  } catch { currentUrl.value = ''; }
  chrome.storage.onChanged.addListener(storageChangeListener);
  await reloadVault();
});

onUnmounted(() => {
  clearAllTimers();
  chrome.storage.onChanged.removeListener(storageChangeListener);
});

async function reloadVault() {
  if (!isSetupComplete.value) return;
  const key = await getValidSessionKey();
  managementLocked.value = !key;
  if (!key) {
    clearAllTimers(); codeData.value.clear(); secrets.value = [];
    editingSecret.value = null; pendingSecret.value = null; currentPage.value = 'home';
    const result = await chrome.runtime.sendMessage({ action: 'getSecrets' });
    accounts.value = Array.isArray(result?.secrets) ? result.secrets.map(toOtpAccount) : [];
    locked.value = result?.locked !== false && !result?.otpAvailable;
    otpAccessMessage.value = result?.message || '';
    if (!locked.value) restartCodeUpdater();
    return;
  }
  locked.value = false;
  try {
    secrets.value = await readVault(key);
    accounts.value = secrets.value.map(toOtpAccount);
    savedState = JSON.stringify(secrets.value);
    const data = await chrome.storage.session.get<{ pendingSecret?: PendingSecret }>(['pendingSecret']);
    const legacy = await chrome.storage.local.get<{ encryptedPendingSecret?: string }>(['encryptedPendingSecret']);
    const pending = data.pendingSecret || (legacy.encryptedPendingSecret
      ? JSON.parse(await CryptoUtils.decrypt(legacy.encryptedPendingSecret, key)) : null);
    if (pending) {
      pendingSecret.value = pending; currentPage.value = 'create';
      await chrome.storage.session.remove(['pendingSecret']);
      await chrome.storage.local.remove(['encryptedPendingSecret']);
    }
    showRepairModal.value = false;
    restartCodeUpdater();
  } catch (error) {
    if (await getValidSessionKey() !== key) { await reloadVault(); return; }
    secrets.value = []; accounts.value = []; clearAllTimers();
    repairError.value = (error as Error).message; showRepairModal.value = true;
  }
}

async function unlock() {
  unlocking.value = true; unlockError.value = '';
  try {
    if (!await authStore.login(unlockPassword.value)) {
      unlockError.value = authStore.isLocked() ? '尝试次数过多，请稍后重试' : '主密码错误';
      return;
    }
    unlockPassword.value = ''; await reloadVault();
  } catch (error) { unlockError.value = (error as Error).message; }
  finally { unlocking.value = false; }
}

function storageChangeListener(changes: Record<string, chrome.storage.StorageChange>) {
  if (changes.encryptedSecrets || changes.deviceOtpEnabled || changes.encryptedDeviceOtpSecrets || changes.sessionKey || changes.sessionExpiresAt) void reloadVault();
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

// 验证码计时
function startCodeUpdater() {
  if (!Array.isArray(accounts.value)) return;
  accounts.value.forEach(secret => {
    startCardTimer(secret);
  });
}

function startCardTimer(secret: OtpAccount) {
  void refreshSecretCode(secret);
  if (secret.type === 'hotp') return;
  const timerId = setInterval(() => refreshSecretCode(secret), 1000);
  timers.value.set(secret.id, timerId);
}

async function refreshSecretCode(secret: OtpAccount) {
  try {
    const result = await TOTP.generateCode(secret);
    codeData.value.set(secret.id, result);
  } catch {
    codeData.value.delete(secret.id);
  }
}

function clearAllTimers() {
  timers.value.forEach(timer => clearInterval(timer));
  timers.value.clear();
}

function restartCodeUpdater() {
  clearAllTimers();
  startCodeUpdater();
}

// 由后台校验版本并写入加密存储。
async function saveSecrets(expectedState = savedState) {
  if (!Array.isArray(secrets.value)) return;
  try { await persistSecrets(secrets.value, expectedState); return true; }
  catch (error) { await reloadVault(); showToast((error as Error).message, 'error'); return false; }
}

// 导航
function showHomePage() {
  editingSecret.value = null;
  pendingSecret.value = null;
  currentPage.value = 'home';
  restartCodeUpdater();
}

function openCreatePage() {
  if (managementLocked.value) { openOptionsPage(); return; }
  pendingSecret.value = null;
  editingSecret.value = null;
  currentPage.value = 'create';
}

async function scanCurrentPage() {
  if (managementLocked.value) { openOptionsPage(); return; }
  try {
    await chrome.runtime.sendMessage({ action: 'startQrScan' });
  } catch (error) {
    showToast('无法扫描当前页面', 'error');
    console.error('OpenPass: 启动二维码扫描失败', error);
    return;
  }
  window.close();
}

function showEditPage(account: OtpAccount) {
  if (managementLocked.value) { openOptionsPage(); return; }
  const secret = secrets.value.find((entry) => entry.id === account.id);
  if (!secret) return;
  editingState = savedState;
  editingSecret.value = { ...secret };
  currentPage.value = 'edit';
  clearAllTimers();
}

const createInitial = computed<FormPayload>(() => {
  if (pendingSecret.value) {
    return {
      secret: pendingSecret.value.secret,
      site: pendingSecret.value.site,
      name: pendingSecret.value.name,
      ...normalizeOtpSettings(pendingSecret.value)
    };
  }
  return { secret: '', site: getDefaultSite(), name: '', ...normalizeOtpSettings({}) };
});

const editInitial = computed<FormPayload>(() => ({
  secret: editingSecret.value?.secret ?? '',
  site: editingSecret.value?.site ?? '',
  name: editingSecret.value?.name ?? '',
  ...normalizeOtpSettings(editingSecret.value || {})
}));

// 创建 / 编辑 / 删除
async function handleCreateSubmit(data: FormPayload) {
  const newSecret: Secret = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    secret: data.secret,
    ...normalizeOtpSettings(data),
    site: data.site,
    name: data.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  secrets.value.push(newSecret);
  if (!await saveSecrets()) return;
  showToast('密钥已保存', 'success');
  showHomePage();
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
  restartCodeUpdater();
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
  <div class="flex flex-col h-full min-h-[480px] bg-gray-50 text-gray-900">
    <!-- 未设置引导 -->
    <PopupSetupPrompt v-if="!isSetupComplete" @setup="openSetupPage" />

    <form v-else-if="locked" class="flex flex-col gap-4 p-6" @submit.prevent="unlock">
      <h2 class="text-lg font-semibold">解锁 OpenPass</h2>
      <p v-if="otpAccessMessage" class="text-sm text-gray-500">{{ otpAccessMessage }}</p>
      <input v-model="unlockPassword" type="password" class="input" autocomplete="current-password" placeholder="主密码" required>
      <p v-if="unlockError" class="text-red-600">{{ unlockError }}</p>
      <button class="btn-primary" :disabled="unlocking">{{ unlocking ? '解锁中…' : '解锁' }}</button>
      <button type="button" class="btn-secondary" @click="openOptionsPage">打开管理页面</button>
    </form>
    <template v-else>
      <PopupHeader
        @add="openCreatePage"
        @scan="scanCurrentPage"
        @about="showAboutModal = true"
        @manage="openOptionsPage"
      />

      <main class="flex-1 overflow-y-auto p-3">
        <PopupHomePage
          v-if="currentPage === 'home'"
          :secrets="accounts"
          :code-data="codeData"
          :current-url="currentUrl"
          @add="openCreatePage"
          @manage="openOptionsPage"
          @copy="copyCode"
          @edit="showEditPage"
          @delete="deleteSecretFromList"
          @open-site="openSite"
        />

        <PopupSecretForm
          v-else-if="currentPage === 'create'"
          mode="create"
          :initial="createInitial"
          @submit="handleCreateSubmit"
          @back="showHomePage"
        />

        <PopupSecretForm
          v-else-if="currentPage === 'edit'"
          mode="edit"
          :initial="editInitial"
          @submit="handleEditSubmit"
          @back="showHomePage"
          @delete="handleDeleteFromEdit"
        />
      </main>
    </template>

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
  min-height: 480px;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
</style>
