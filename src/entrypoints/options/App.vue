<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useSecretStore } from '@/stores/secrets';
import { useKeyboardShortcuts } from '@/composables/useKeyboardShortcuts';
import Sidebar from '@/components/manager/Sidebar.vue';
import SecretTable from '@/components/manager/SecretTable.vue';
import SecretModal from '@/components/manager/SecretModal.vue';
import BackupPanel from '@/components/manager/BackupPanel.vue';
import SettingsPanel from '@/components/manager/SettingsPanel.vue';
import AboutPanel from '@/components/manager/AboutPanel.vue';
import WelcomeGuide from '@/components/manager/WelcomeGuide.vue';
import ErrorCenter from '@/components/manager/ErrorCenter.vue';
import type { Secret } from '@/stores/secrets';
import { showToast } from '@/utils/ui';

const authStore = useAuthStore();
const secretStore = useSecretStore();

const currentPage = ref('secrets');
const showWelcome = ref(false);
const welcomeGuideKey = ref(0);
const showSecretModal = ref(false);
const editingSecret = ref<Secret | null>(null);
const loading = ref(true);
let lastActivityAt = 0;

function getAuthRedirect() {
  const redirect = window.location.pathname.split('/').pop() || 'options.html';
  return `/auth.html?redirect=${redirect}`;
}

function redirectToAuth() {
  window.location.href = getAuthRedirect();
}

function isExtensionContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

async function handleLogout() {
  if (!isExtensionContextValid()) {
    redirectToAuth();
    return;
  }
  
  try {
    cleanupActivityListener();
    await authStore.clearSession();
    
    setTimeout(() => {
      redirectToAuth();
    }, 100);
  } catch {
    redirectToAuth();
  }
}

async function ensureAuthenticated() {
  const authenticated = await authStore.checkSession();
  if (!authenticated) {
    redirectToAuth();
    return false;
  }

  return true;
}

async function handleActivity() {
  const now = Date.now();
  if (now - lastActivityAt < 30 * 1000) {
    return;
  }

  lastActivityAt = now;
  await authStore.updateActivity();
}

async function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    await ensureAuthenticated();
  }
}

function setupActivityListener() {
  document.addEventListener('click', handleActivity);
  document.addEventListener('keydown', handleActivity);
  document.addEventListener('mousemove', handleActivity, { passive: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function cleanupActivityListener() {
  document.removeEventListener('click', handleActivity);
  document.removeEventListener('keydown', handleActivity);
  document.removeEventListener('mousemove', handleActivity);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

async function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: chrome.storage.AreaName
) {
  if (areaName !== 'local') {
    return;
  }

  if (!changes.secrets && !changes.encryptedSecrets) {
    return;
  }

  await secretStore.loadSecrets();

  if (currentPage.value === 'secrets') {
    shortcuts.setTotal(secretStore.getFilteredSecrets().length);
  }
}

// 键盘快捷键
const shortcuts = useKeyboardShortcuts({
  onSearch: () => {
    const input = document.querySelector('input[placeholder="搜索密钥..."]') as HTMLInputElement;
    input?.focus();
  },
  onAdd: () => {
    if (currentPage.value === 'secrets') {
      showSecretModal.value = true;
    }
  },
  onSettings: () => currentPage.value = 'settings',
  onHelp: () => currentPage.value = 'about',
  onEdit: () => {
    const selectedSecret = getSelectedSecret();
    if (currentPage.value === 'secrets' && selectedSecret) {
      editSecret(selectedSecret);
    }
  },
  onDelete: async () => {
    const selectedSecret = getSelectedSecret();
    if (currentPage.value === 'secrets' && selectedSecret) {
      await secretStore.deleteSecret(selectedSecret.id);
    }
  },
  onCopy: async () => {
    const selectedSecret = getSelectedSecret();
    if (currentPage.value === 'secrets' && selectedSecret) {
      const { TOTP } = await import('@/utils/totp');
      const result = await TOTP.generateCode(selectedSecret.secret, selectedSecret.digits || 6);
      await TOTP.copyToClipboard(result.code);
      showToast('验证码已复制', 'success');
    }
  },
  onSelectNext: () => {},
  onSelectPrevious: () => {},
  isModalOpen: () => showSecretModal.value || showWelcome.value,
  isInputFocused: () => {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
});

onMounted(async () => {
  await authStore.init();

  // 检查是否首次使用（未设置主密码）
  const setupResult = await chrome.storage.local.get(['masterPasswordHash', 'isSetupComplete']);
  if (!setupResult.masterPasswordHash) {
    // 首次使用，直接显示欢迎引导，不跳转认证页面
    showWelcome.value = true;
    await secretStore.loadSecrets();
    loading.value = false;
    shortcuts.register();
    return;
  }

  if (!(await ensureAuthenticated())) {
    return;
  }

  await secretStore.loadSecrets();
  await authStore.updateActivity();

  // 检查是否需要显示欢迎引导
  const result = await chrome.storage.local.get(['isSetupComplete', 'welcomeCompleted', 'secrets']);
  if (!result.isSetupComplete || !result.welcomeCompleted) {
    showWelcome.value = true;
  }

  shortcuts.register();
  shortcuts.setTotal(secretStore.secrets.length);
  setupActivityListener();
  chrome.storage.onChanged.addListener(handleStorageChange);

  loading.value = false;
});

onUnmounted(() => {
  shortcuts.unregister();
  cleanupActivityListener();
  chrome.storage.onChanged.removeListener(handleStorageChange);
});

function addSecret() {
  editingSecret.value = null;
  showSecretModal.value = true;
}

function getSelectedSecret() {
  const filteredSecrets = secretStore.getFilteredSecrets();
  if (filteredSecrets.length === 0) {
    return null;
  }

  const selectedIndex = shortcuts.selectedIndex.value;
  if (selectedIndex >= 0 && selectedIndex < filteredSecrets.length) {
    return filteredSecrets[selectedIndex];
  }

  return filteredSecrets[0];
}

function editSecret(secret: Secret) {
  editingSecret.value = secret;
  showSecretModal.value = true;
}

async function deleteSecret(secret: Secret) {
  if (confirm(`确定要删除 "${secret.name || secret.site}" 吗？`)) {
    await secretStore.deleteSecret(secret.id);
  }
}

function handleModalClose() {
  showSecretModal.value = false;
  editingSecret.value = null;
}

function handleWelcomeClose() {
  showWelcome.value = false;
}

function handleWelcomeNavigate(page: string) {
  showWelcome.value = false;
  if (page === 'secrets:add') {
    currentPage.value = 'secrets';
    addSecret();
    return;
  }

  currentPage.value = page;
}

watch(showWelcome, (visible) => {
  if (!visible) {
    return;
  }

  welcomeGuideKey.value += 1;
  if (showSecretModal.value) {
    handleModalClose();
  }
});

watch(
  () => [currentPage.value, secretStore.searchQuery, secretStore.secrets.length],
  () => {
    if (currentPage.value !== 'secrets') {
      shortcuts.setTotal(0);
      shortcuts.clearSelection();
      return;
    }

    shortcuts.setTotal(secretStore.getFilteredSecrets().length);
  }
);
</script>

<template>
  <div v-if="loading" class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="text-center">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
      <p class="mt-4 text-gray-600">加载中...</p>
    </div>
  </div>

  <div v-else class="flex min-h-screen bg-gray-50">
    <!-- 侧边栏 -->
    <Sidebar :current-page="currentPage" @navigate="currentPage = $event" @logout="handleLogout" />

    <!-- 主内容 -->
    <main class="flex-1 min-w-0 p-8 overflow-y-auto">
      <!-- 密钥管理页 -->
      <SecretTable
        v-if="currentPage === 'secrets'"
        :selected-index="shortcuts.selectedIndex.value"
        @add="addSecret"
        @edit="editSecret"
        @delete="deleteSecret"
      />

      <!-- 备份恢复页 -->
      <BackupPanel v-else-if="currentPage === 'backup'" />

      <!-- 设置页 -->
      <SettingsPanel v-else-if="currentPage === 'settings'" />

      <!-- 关于页 -->
      <AboutPanel v-else-if="currentPage === 'about'" />
    </main>

    <!-- 密钥表单模态框 -->
    <SecretModal
      :open="showSecretModal"
      :editing-secret="editingSecret"
      @close="handleModalClose"
    />

    <!-- 欢迎引导 -->
    <WelcomeGuide
      :key="welcomeGuideKey"
      v-if="showWelcome"
      @close="handleWelcomeClose"
      @navigate="handleWelcomeNavigate"
    />

    <ErrorCenter />
  </div>
</template>
