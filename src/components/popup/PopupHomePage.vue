<script setup lang="ts">
import { ref, computed } from 'vue';
import { getSiteMatchPriority, NO_MATCH, parseUrl } from '@/utils/domainMatch';
import type { Secret } from '@/stores/secrets';
import PopupSecretCard from './PopupSecretCard.vue';

interface CodeEntry {
  code: string;
  remainingSeconds: number;
}

interface Props {
  secrets: Secret[];
  codeData: Map<string, CodeEntry>;
  currentUrl: string;
}

interface Emits {
  (e: 'add'): void;
  (e: 'manage'): void;
  (e: 'copy', secret: Secret): void;
  (e: 'edit', secret: Secret): void;
  (e: 'delete', secret: Secret): void;
  (e: 'open-site', secret: Secret): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const searchQuery = ref('');

const currentSiteMatches = computed(() => {
  if (!props.currentUrl || !Array.isArray(props.secrets)) return [];
  const urlInfo = parseUrl(props.currentUrl);
  if (!urlInfo) return [];

  return props.secrets
    .map(secret => ({ secret, priority: getSiteMatchPriority(urlInfo, secret.site) }))
    .filter(item => item.priority !== NO_MATCH)
    .sort((a, b) => a.priority - b.priority)
    .map(item => item.secret);
});

const searchResults = computed(() => {
  if (!searchQuery.value || !Array.isArray(props.secrets)) return [];
  const query = searchQuery.value.toLowerCase();
  return props.secrets.filter(s =>
    s.name?.toLowerCase().includes(query) ||
    s.site.toLowerCase().includes(query)
  );
});

function formatCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}

function getCode(secretId: string): string {
  return formatCode(props.codeData.get(secretId)?.code || '------');
}

function getRemaining(secretId: string): number {
  return props.codeData.get(secretId)?.remainingSeconds || 30;
}
</script>

<template>
  <div>
    <!-- 搜索框 -->
    <div class="relative mb-3">
      <svg
        class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        v-model="searchQuery"
        type="text"
        class="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-all placeholder:text-gray-400"
        placeholder="搜索站点或名称..."
      >
    </div>

    <!-- 当前站点匹配 -->
    <div
      v-if="currentSiteMatches.length > 0"
      class="bg-primary-50 border border-primary-200 rounded-lg p-3 mb-3"
    >
      <div class="flex items-center gap-1.5 text-xs font-medium text-primary-700 mb-2.5">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span>当前站点</span>
      </div>
      <div class="flex flex-col gap-2">
        <PopupSecretCard
          v-for="secret in currentSiteMatches"
          :key="secret.id"
          :secret="secret"
          :code="getCode(secret.id)"
          :remaining="getRemaining(secret.id)"
          @copy="emit('copy', $event)"
          @edit="emit('edit', $event)"
          @open-site="emit('open-site', $event)"
        />
      </div>
    </div>

    <!-- 搜索结果 -->
    <div v-if="searchQuery" class="mt-2">
      <div class="flex items-center gap-2 text-[13px] font-medium text-gray-500 mb-2.5 px-1">
        <span>搜索结果</span>
        <span class="bg-gray-200 text-gray-500 text-[11px] px-2 py-0.5 rounded-full">
          {{ searchResults.length }}
        </span>
      </div>

      <div v-if="searchResults.length > 0" class="flex flex-col gap-2">
        <PopupSecretCard
          v-for="secret in searchResults"
          :key="secret.id"
          :secret="secret"
          :code="getCode(secret.id)"
          :remaining="getRemaining(secret.id)"
          show-delete
          @copy="emit('copy', $event)"
          @edit="emit('edit', $event)"
          @delete="emit('delete', $event)"
          @open-site="emit('open-site', $event)"
        />
      </div>

      <div v-else class="text-center py-10 px-4 text-gray-400">
        <svg class="mx-auto mb-4 w-12 h-12 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <p class="text-sm">未找到匹配结果</p>
      </div>
    </div>

    <!-- 默认状态 -->
    <div v-if="!searchQuery" class="py-3">
      <!-- 统计卡片 -->
      <div
        class="flex items-center gap-3 p-4 rounded-lg mb-4 text-white"
        :style="{ backgroundImage: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' }"
      >
        <div class="w-12 h-12 bg-white/20 rounded-[10px] flex items-center justify-center shrink-0">
          <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div class="flex-1">
          <div class="text-[28px] font-bold leading-none">{{ secrets.length }}</div>
          <div class="text-xs opacity-90 mt-0.5">个密钥</div>
        </div>
        <button
          type="button"
          class="w-10 h-10 bg-white/20 rounded-[10px] flex items-center justify-center shrink-0 hover:bg-white/30 transition-colors"
          title="添加密钥"
          @click="emit('add')"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <!-- 快捷操作 -->
      <div class="flex gap-2.5 mb-4">
        <button
          type="button"
          class="flex-1 flex flex-col items-center gap-1.5 px-2.5 py-3.5 bg-white border border-gray-200 rounded-lg text-gray-500 hover:border-primary-600 hover:text-primary-600 hover:bg-primary-50 transition-colors"
          @click="emit('add')"
        >
          <svg class="w-5 h-5 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span class="text-xs font-medium">手动添加</span>
        </button>
        <button
          type="button"
          class="flex-1 flex flex-col items-center gap-1.5 px-2.5 py-3.5 bg-white border border-gray-200 rounded-lg text-gray-500 hover:border-primary-600 hover:text-primary-600 hover:bg-primary-50 transition-colors"
          @click="emit('manage')"
        >
          <svg class="w-5 h-5 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
          <span class="text-xs font-medium">管理密钥</span>
        </button>
      </div>

      <!-- 使用提示 -->
      <div class="bg-gray-50 rounded-lg px-3.5 py-3">
        <div class="flex items-center gap-2.5 py-1.5 text-xs text-gray-500">
          <svg class="shrink-0 w-4 h-4 text-primary-600 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>输入关键词搜索验证码</span>
        </div>
        <div class="flex items-center gap-2.5 py-1.5 text-xs text-gray-500">
          <svg class="shrink-0 w-4 h-4 text-primary-600 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>点击验证码可快速复制</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div
      v-if="secrets.length === 0 && !searchQuery"
      class="flex flex-col items-center justify-center text-center py-8 px-5"
    >
      <div class="mb-3 text-gray-400 opacity-40 flex justify-center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <h3 class="text-[15px] font-semibold mb-1.5 text-gray-900">暂无密钥</h3>
      <p class="text-xs text-gray-400">点击上方添加按钮创建第一个密钥</p>
    </div>
  </div>
</template>
