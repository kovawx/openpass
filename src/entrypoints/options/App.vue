<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useSecretStore } from '@/stores/secrets';
import { useKeyboardShortcuts } from '@/composables/useKeyboardShortcuts';
import Sidebar from '@/components/manager/Sidebar.vue';
import SecretTable from '@/components/manager/SecretTable.vue';
import type { Secret } from '@/stores/secrets';
import { showToast } from '@/utils/ui';

const SecretModal = defineAsyncComponent(() => import('@/components/manager/SecretModal.vue'));
const AuthenticatorImport = defineAsyncComponent(() => import('@/components/manager/AuthenticatorImport.vue'));
const BackupPanel = defineAsyncComponent(() => import('@/components/manager/BackupPanel.vue'));
const SettingsPanel = defineAsyncComponent(() => import('@/components/manager/SettingsPanel.vue'));
const AboutPanel = defineAsyncComponent(() => import('@/components/manager/AboutPanel.vue'));
const WelcomeGuide = defineAsyncComponent(() => import('@/components/manager/WelcomeGuide.vue'));
const ErrorCenter = defineAsyncComponent(() => import('@/components/manager/ErrorCenter.vue'));

const authStore = useAuthStore();
const secretStore = useSecretStore();

const currentPage = ref('secrets');
const showWelcome = ref(false);
const welcomeGuideKey = ref(0);
const showSecretModal = ref(false);
const showAuthenticatorImport = ref(false);
const editingSecret = ref<Secret | null>(null);
const loading = ref(true);
let lastActivityAt = 0;
let managementStarted = false;

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
  if (areaName !== 'local' && areaName !== 'session') {
    return;
  }

  if ((areaName === 'session' && (changes.sessionKey || changes.sessionExpiresAt)) ||
      (areaName === 'local' && changes.sessionExpiresAt && changes.sessionExpiresAt.newValue === undefined)) {
    if (!await ensureAuthenticated()) return;
  }
  if ((areaName === 'session' && changes.sessionKey) ||
      (areaName === 'local' && (changes.encryptedSecrets || changes.hotpCounters))) {
    await secretStore.loadSecrets(authStore.sessionKey ?? undefined);
  }
}

// 键盘快捷键
const shortcuts = useKeyboardShortcuts({
  onSearch: () => {
    const input = document.querySelector('[data-account-search]') as HTMLInputElement;
    input?.focus();
  },
  onAdd: () => {
    if (currentPage.value === 'secrets' && !secretStore.loading) {
      addSecret();
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
      const result = await TOTP.generateCode(selectedSecret, 6, {}, true);
      await TOTP.copyToClipboard(result.code);
      showToast('验证码已复制', 'success');
    }
  },
  onSelectNext: () => {},
  onSelectPrevious: () => {},
  isModalOpen: () => showSecretModal.value || showAuthenticatorImport.value || showWelcome.value,
  isInputFocused: () => {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
});

function startManagementSession() {
  if (managementStarted || !authStore.sessionKey) return;
  managementStarted = true;
  setupActivityListener();
  chrome.storage.onChanged.addListener(handleStorageChange);
  void secretStore.loadSecrets(authStore.sessionKey);
  void handleActivity();
}

onMounted(async () => {
  const [setup, authenticated] = await Promise.all([
    chrome.storage.local.get(['masterPasswordHash', 'isSetupComplete', 'welcomeCompleted']),
    authStore.checkSession()
  ]);
  const configured = setup.isSetupComplete === true || !!setup.masterPasswordHash;
  if (configured && !authenticated) {
    redirectToAuth();
    return;
  }

  showWelcome.value = !configured || !setup.welcomeCompleted;
  if (authenticated) startManagementSession();
  shortcuts.register();
  loading.value = false;
});

watch(() => authStore.isAuthenticated, (authenticated) => {
  if (authenticated && !loading.value) startManagementSession();
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
  const filteredSecrets = secretStore.filteredSecrets;
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
  () => [currentPage.value, secretStore.filteredSecrets],
  () => {
    if (currentPage.value !== 'secrets') {
      shortcuts.setTotal(0);
      shortcuts.clearSelection();
      return;
    }

    shortcuts.setTotal(secretStore.filteredSecrets.length);
    shortcuts.clearSelection();
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
        @import="showAuthenticatorImport = true"
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
      v-if="showSecretModal"
      :open="showSecretModal"
      :editing-secret="editingSecret"
      @close="handleModalClose"
    />
    <AuthenticatorImport v-if="showAuthenticatorImport" @close="showAuthenticatorImport = false" />

    <!-- 欢迎引导 -->
    <WelcomeGuide
      v-if="showWelcome"
      :key="welcomeGuideKey"
      @close="handleWelcomeClose"
      @navigate="handleWelcomeNavigate"
    />

    <ErrorCenter />
  </div>
</template>
