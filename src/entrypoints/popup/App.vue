<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import TOTP from '@/utils/totp';
import CryptoUtils from '@/utils/crypto';
import { parseUrl } from '@/utils/domainMatch';
import { showToast } from '@/utils/ui';
import type { Secret } from '@/stores/secrets';

import PopupHeader from '@/components/popup/PopupHeader.vue';
import PopupHomePage from '@/components/popup/PopupHomePage.vue';
import PopupSecretForm from '@/components/popup/PopupSecretForm.vue';
import PopupAboutModal from '@/components/popup/PopupAboutModal.vue';
import PopupRepairModal from '@/components/popup/PopupRepairModal.vue';
import PopupSetupPrompt from '@/components/popup/PopupSetupPrompt.vue';

interface PendingSecret {
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
type TimeoutHandle = ReturnType<typeof setTimeout>;
type Page = 'home' | 'create' | 'edit';

interface FormPayload {
  secret: string;
  site: string;
  name: string;
  digits: number;
}

// 基础状态
const secrets = ref<Secret[]>([]);
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
let expectedSecretsSignature: string | null = null;
let expectedSecretsSignatureTimer: TimeoutHandle | null = null;

onMounted(async () => {
  version.value = chrome.runtime.getManifest().version;

  // 检查设置是否完成，并读取所有相关数据
  const result = await chrome.storage.local.get<{
    isSetupComplete?: boolean;
    secrets?: Secret[];
    encryptedSecrets?: string;
    pendingSecret?: PendingSecret;
  }>(['isSetupComplete', 'secrets', 'encryptedSecrets', 'pendingSecret']);
  isSetupComplete.value = result.isSetupComplete === true;

  if (!isSetupComplete.value) {
    return;
  }

  const sessionKey = await getActiveSessionKey();

  // popup 优先读取明文 secrets，并在有会话时同步加密副本
  if (Array.isArray(result.secrets)) {
    // 明文 secrets（含空数组）即为合法数据源，以明文为准
    secrets.value = normalizeSecrets(result.secrets);
    repairError.value = '';

    if (sessionKey) {
      await persistSecrets(result.secrets, sessionKey);
    }
    // 无会话时不删除 encryptedSecrets（保留作为备份），避免误判与备份丢失
  } else if (result.encryptedSecrets) {
    if (sessionKey) {
      try {
        secrets.value = await restoreSecretsFromEncrypted(result.encryptedSecrets, sessionKey);
        repairError.value = '';
      } catch (error) {
        console.warn('[Popup] 无法用当前会话自动同步加密数据', error);
        secrets.value = [];
        repairError.value = '检测到加密数据，但当前会话无法自动同步。请打开管理后台重新验证主密码后继续。';
        showRepairModal.value = true;
      }
    } else {
      console.warn('[Popup] 仅检测到加密数据，等待管理后台同步');
      secrets.value = [];
      repairError.value = '检测到当前只有加密数据。请打开管理后台完成解锁后，popup 会自动同步。';
      showRepairModal.value = true;
    }
  } else {
    secrets.value = [];
  }

  // 获取当前标签页
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      currentUrl.value = tab.url;
    }
  } catch {
    currentUrl.value = '';
  }

  // 检查待添加密钥（右键菜单 QR 识别写入）
  if (result.pendingSecret) {
    pendingSecret.value = result.pendingSecret;
    await chrome.storage.local.remove(['pendingSecret']);
    currentPage.value = 'create';
  }

  // 启动验证码更新
  startCodeUpdater();

  // 监听 storage 变化，同步密钥数据
  chrome.storage.onChanged.addListener(storageChangeListener);
});

onUnmounted(() => {
  clearAllTimers();
  clearExpectedSecretsSync();
  chrome.storage.onChanged.removeListener(storageChangeListener);
});

function storageChangeListener(changes: Record<string, chrome.storage.StorageChange>) {
  if (changes.secrets) {
    const newValue = changes.secrets.newValue;
    if (!Array.isArray(newValue)) {
      console.warn('[Popup] 忽略异常的 secrets 变更', newValue);
      return;
    }

    const normalizedSecrets = normalizeSecrets(newValue);
    const nextSignature = getSecretsSignature(normalizedSecrets);
    const currentSignature = getSecretsSignature(secrets.value);

    if (
      expectedSecretsSignature &&
      normalizedSecrets.length === 0 &&
      currentSignature !== nextSignature
    ) {
      console.warn('[Popup] 忽略保存过程中的瞬时空 secrets 同步');
      return;
    }

    if (currentSignature === nextSignature) {
      if (expectedSecretsSignature === nextSignature) {
        clearExpectedSecretsSync();
      }
      showRepairModal.value = false;
      repairError.value = '';
      return;
    }

    secrets.value = normalizedSecrets;
    showRepairModal.value = false;
    repairError.value = '';
    if (expectedSecretsSignature === nextSignature) {
      clearExpectedSecretsSync();
    }
    restartCodeUpdater();
  }
}

// 会话与存储自愈逻辑（与 secret store、background 保持一致，勿随意改动写入路径）
async function getActiveSessionKey() {
  const [localResult, sessionResult] = await Promise.all([
    chrome.storage.local.get<{ sessionExpiresAt?: number }>(['sessionExpiresAt']),
    chrome.storage.session.get<{ sessionKey?: string }>(['sessionKey'])
  ]);

  if (
    typeof localResult.sessionExpiresAt === 'number' &&
    Date.now() > localResult.sessionExpiresAt
  ) {
    await chrome.storage.session.remove(['sessionKey']);
    await chrome.storage.local.remove(['sessionExpiresAt']);
    return null;
  }

  return typeof sessionResult.sessionKey === 'string' ? sessionResult.sessionKey : null;
}

function buildSitesList(nextSecrets: Secret[]) {
  return nextSecrets.map(secret => ({ site: secret.site }));
}

function normalizeSecrets(nextSecrets: Secret[]) {
  return nextSecrets.map(secret => ({ ...secret }));
}

function getSecretsSignature(nextSecrets: Secret[]) {
  return JSON.stringify(normalizeSecrets(nextSecrets));
}

function rememberExpectedSecretsSync(nextSecrets: Secret[]) {
  expectedSecretsSignature = getSecretsSignature(nextSecrets);
  if (expectedSecretsSignatureTimer) {
    clearTimeout(expectedSecretsSignatureTimer);
  }

  expectedSecretsSignatureTimer = setTimeout(() => {
    clearExpectedSecretsSync();
  }, 3000);
}

function clearExpectedSecretsSync() {
  expectedSecretsSignature = null;
  if (expectedSecretsSignatureTimer) {
    clearTimeout(expectedSecretsSignatureTimer);
    expectedSecretsSignatureTimer = null;
  }
}

async function persistSecrets(nextSecrets: Secret[], sessionKey?: string | null) {
  const normalizedSecrets = normalizeSecrets(nextSecrets);
  const activeSessionKey = sessionKey === undefined ? await getActiveSessionKey() : sessionKey;
  const sitesList = buildSitesList(normalizedSecrets);
  rememberExpectedSecretsSync(normalizedSecrets);

  if (activeSessionKey) {
    const encryptedSecrets = await CryptoUtils.encrypt(
      JSON.stringify(normalizedSecrets),
      activeSessionKey
    );
    await chrome.storage.local.set({
      secrets: normalizedSecrets,
      sitesList,
      encryptedSecrets
    });
    return;
  }

  // 无会话：仅更新明文与索引，保留现有 encryptedSecrets（备份），待下次有会话时重加密同步
  await chrome.storage.local.set({
    secrets: normalizedSecrets,
    sitesList
  });
}

async function restoreSecretsFromEncrypted(encryptedSecrets: string, sessionKey: string) {
  const decrypted = await CryptoUtils.decrypt(encryptedSecrets, sessionKey);
  const parsed = JSON.parse(decrypted);

  if (!Array.isArray(parsed)) {
    throw new Error('解密后的数据格式无效');
  }

  await persistSecrets(parsed, sessionKey);
  return normalizeSecrets(parsed as Secret[]);
}

function getDefaultSite() {
  const urlInfo = currentUrl.value ? parseUrl(currentUrl.value) : null;
  return urlInfo?.fullUrl ?? '';
}

// 验证码计时
function startCodeUpdater() {
  if (!Array.isArray(secrets.value)) return;
  secrets.value.forEach(secret => {
    startCardTimer(secret);
  });
}

function startCardTimer(secret: Secret) {
  refreshSecretCode(secret);
  const timerId = setInterval(() => refreshSecretCode(secret), 1000);
  timers.value.set(secret.id, timerId);
}

async function refreshSecretCode(secret: Secret) {
  try {
    const result = await TOTP.generateCode(secret.secret, secret.digits || 6);
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

// 保存密钥（双存储 + 加密一致）
async function saveSecrets() {
  if (!Array.isArray(secrets.value)) return;
  await persistSecrets(secrets.value);
}

// 导航
function showHomePage() {
  editingSecret.value = null;
  pendingSecret.value = null;
  currentPage.value = 'home';
  restartCodeUpdater();
}

function openCreatePage() {
  pendingSecret.value = null;
  editingSecret.value = null;
  currentPage.value = 'create';
}

async function scanCurrentPage() {
  try {
    await chrome.runtime.sendMessage({ action: 'startQrScan' });
  } catch (error) {
    showToast('无法扫描当前页面', 'error');
    console.error('OpenPass: 启动二维码扫描失败', error);
    return;
  }
  window.close();
}

function showEditPage(secret: Secret) {
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
      digits: pendingSecret.value.digits === 8 ? 8 : 6
    };
  }
  return { secret: '', site: getDefaultSite(), name: '', digits: 6 };
});

const editInitial = computed<FormPayload>(() => ({
  secret: editingSecret.value?.secret ?? '',
  site: editingSecret.value?.site ?? '',
  name: editingSecret.value?.name ?? '',
  digits: editingSecret.value?.digits ?? 6
}));

// 创建 / 编辑 / 删除
async function handleCreateSubmit(data: FormPayload) {
  const newSecret: Secret = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    secret: data.secret,
    digits: data.digits,
    site: data.site,
    name: data.name,
    createdAt: new Date().toISOString()
  };

  secrets.value.push(newSecret);
  await saveSecrets();
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
      site: data.site.toLowerCase(),
      name: data.name,
      updatedAt: new Date().toISOString()
    };
    await saveSecrets();
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
  await saveSecrets();
  showToast('密钥已删除', 'success');
  showHomePage();
}

async function deleteSecretFromList(secret: Secret) {
  const name = secret.name || secret.site;
  if (!confirm(`确定要删除 "${name}" 吗？`)) {
    return;
  }

  secrets.value = Array.isArray(secrets.value)
    ? secrets.value.filter(item => item.id !== secret.id)
    : [];
  await saveSecrets();
  showToast('密钥已删除', 'success');
  restartCodeUpdater();
}

async function copyCode(secret: Secret) {
  const data = codeData.value.get(secret.id);
  if (data) {
    await TOTP.copyToClipboard(data.code);
    showToast('验证码已复制', 'success');
  }
}

// 点击名称 / 站点跳转（与 manager 行为一致）
function openSite(secret: Secret) {
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
          :secrets="secrets"
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
