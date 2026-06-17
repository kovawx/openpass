<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useSecretStore, type Secret } from '@/stores/secrets';
import { TOTP } from '@/utils/totp';
import { showToast } from '@/utils/ui';

interface Props {
  selectedIndex?: number;
}

interface Emits {
  (e: 'add'): void;
  (e: 'edit', secret: Secret): void;
  (e: 'delete', secret: Secret): void;
}

const secretStore = useSecretStore();
withDefaults(defineProps<Props>(), {
  selectedIndex: -1
});
const emit = defineEmits<Emits>();

const codeData = ref<Record<string, { code: string; remaining: number }>>({});
let timerInterval: number | null = null;
let initialized = false;

onMounted(() => {
  // 如果 secrets 已经加载完成，立即生成验证码
  if (!secretStore.loading && secretStore.secrets.length > 0) {
    initializeCodes();
  }
  startTimer();
});

onUnmounted(() => {
  stopTimer();
});

// 监听 loading 状态，当加载完成时初始化验证码
watch(
  () => secretStore.loading,
  async (loading) => {
    if (!loading && !initialized && secretStore.secrets.length > 0) {
      await initializeCodes();
      initialized = true;
    }
  }
);

// 监听 secrets 数组长度变化（添加/删除密钥）
watch(
  () => secretStore.secrets.length,
  async (newLength, oldLength) => {
    if (newLength > (oldLength || 0)) {
      // 新增密钥，为新增的生成验证码
      for (const secret of secretStore.secrets) {
        if (!codeData.value[secret.id]) {
          await generateCodeForSecret(secret);
        }
      }
    }
  }
);

async function initializeCodes() {
  for (const secret of secretStore.secrets) {
    await generateCodeForSecret(secret);
  }
  initialized = true;
}

async function generateCodeForSecret(secret: Secret) {
  try {
    const result = await TOTP.generateCode(secret.secret, secret.digits || 6);
    codeData.value[secret.id] = {
      code: TOTP.formatCode(result.code),
      remaining: result.remainingSeconds
    };
  } catch (e) {
    console.error('生成验证码失败:', secret.site, e);
  }
}

function startTimer() {
  timerInterval = window.setInterval(updateAllCodes, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

async function updateAllCodes() {
  for (const secret of secretStore.secrets) {
    const existing = codeData.value[secret.id];
    if (existing && existing.remaining > 1) {
      existing.remaining--;
      continue;
    }

    await generateCodeForSecret(secret);
  }
}

async function copyCode(secret: Secret) {
  const code = codeData.value[secret.id];
  if (code) {
    await TOTP.copyToClipboard(code.code.replace(' ', ''));
    showToast('验证码已复制', 'success');
  }
}

function getProgressClass(remaining: number): string {
  if (remaining <= 5) return 'text-red-600';
  if (remaining <= 10) return 'text-yellow-600';
  return 'text-green-600';
}

// 点击名称/站点：在新标签页打开目标站点（无协议时补 https://）
function openSite(site: string) {
  const trimmed = (site || '').trim();
  if (!trimmed) return;
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  chrome.tabs.create({ url });
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-gray-900">密钥管理</h2>
      <button class="btn-primary" @click="emit('add')">
        <svg class="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        添加密钥
      </button>
    </div>

    <!-- Search -->
    <div class="mb-4">
      <input
        v-model="secretStore.searchQuery"
        placeholder="搜索密钥..."
        class="input"
      />
    </div>

    <!-- Table -->
    <div class="bg-white rounded-lg shadow overflow-x-auto">
      <table class="min-w-full table-fixed divide-y divide-gray-200">
        <colgroup>
          <col class="w-1/4" />
          <col class="w-2/5" />
          <col class="w-32" />
          <col class="w-28" />
        </colgroup>
        <thead class="bg-gray-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">名称</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">站点</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">验证码</th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-if="secretStore.getFilteredSecrets().length === 0">
            <td colspan="4" class="px-6 py-12 text-center text-gray-500">
              <svg class="mx-auto w-12 h-12 mb-3 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <p>暂无密钥</p>
              <button class="mt-3 text-primary-600 hover:text-primary-700 text-sm font-medium" @click="emit('add')">
                添加第一个密钥 →
              </button>
            </td>
          </tr>
          <tr
            v-for="(secret, index) in secretStore.getFilteredSecrets()"
            :key="secret.id"
            class="cursor-pointer transition-colors"
            :class="index === selectedIndex ? 'bg-primary-50 ring-1 ring-inset ring-primary-200' : 'hover:bg-gray-50'"
          >
            <td class="px-6 py-4 max-w-0">
              <div
                class="text-sm font-medium text-gray-900 truncate cursor-pointer hover:text-primary-600 transition-colors"
                :title="secret.name || '未命名'"
                @click="openSite(secret.site)"
              >{{ secret.name || '未命名' }}</div>
            </td>
            <td class="px-6 py-4 max-w-0">
              <div
                class="text-sm text-gray-500 truncate cursor-pointer hover:text-primary-600 transition-colors"
                :title="secret.site"
                @click="openSite(secret.site)"
              >{{ secret.site }}</div>
            </td>
            <td class="px-6 py-4">
              <div v-if="codeData[secret.id]" class="flex items-center space-x-2">
                <span
                  class="text-lg font-mono font-semibold cursor-pointer hover:text-primary-600 transition-colors"
                  title="点击复制验证码"
                  @click="copyCode(secret)"
                >
                  {{ codeData[secret.id].code }}
                </span>
                <span
                  class="text-xs font-mono"
                  :class="getProgressClass(codeData[secret.id].remaining)"
                >
                  {{ codeData[secret.id].remaining }}s
                </span>
              </div>
              <div v-else class="text-sm text-gray-400">生成中...</div>
            </td>
            <td class="px-6 py-4 text-right">
              <div class="flex items-center justify-end space-x-2">
                <button
                  class="text-gray-400 hover:text-primary-600 transition-colors"
                  title="复制验证码"
                  @click="copyCode(secret)"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
                <button
                  class="text-gray-400 hover:text-blue-600 transition-colors"
                  title="编辑"
                  @click="emit('edit', secret)"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  class="text-gray-400 hover:text-red-600 transition-colors"
                  title="删除"
                  @click="emit('delete', secret)"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
