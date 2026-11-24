<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { matchSecrets } from '@/utils/domainMatch';
import type { OtpAccount as Secret } from '@/utils/vault';
import PopupSecretCard from './PopupSecretCard.vue';
import AccountFilters from '@/components/AccountFilters.vue';
import { filterAccounts, getAccountGroups } from '@/utils/accountOrganization';

interface CodeEntry {
  code: string;
  remainingSeconds: number;
}

interface Props {
  secrets: Secret[];
  codeData: Map<string, CodeEntry>;
  currentUrl: string;
  organizing?: boolean;
}

interface Emits {
  (e: 'add'): void;
  (e: 'scan'): void;
  (e: 'copy', secret: Secret): void;
  (e: 'edit', secret: Secret): void;
  (e: 'delete', secret: Secret): void;
  (e: 'open-site', secret: Secret): void;
  (e: 'favorite', secret: Secret): void;
  (e: 'delete-group', group: string): void;
  (e: 'visible-accounts', accounts: Secret[]): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const searchQuery = ref('');
const showAll = ref(false);
const selectedGroup = ref<string | null>(null);
const favoritesOnly = ref(false);
const groups = computed(() => getAccountGroups(props.secrets));
const searching = computed(() => !!searchQuery.value.trim());
const hasFilters = computed(() => searching.value || (showAll.value && (selectedGroup.value !== null || favoritesOnly.value)));

const currentSiteMatches = computed(() => {
  if (!props.currentUrl || !Array.isArray(props.secrets)) return [];
  return matchSecrets(props.currentUrl, props.secrets);
});

const visibleAccounts = computed(() => {
  if (!showAll.value && !searching.value) return currentSiteMatches.value;
  return hasFilters.value ? filterAccounts(props.secrets, {
    query: searchQuery.value, group: selectedGroup.value, favoritesOnly: favoritesOnly.value
  }) : props.secrets;
});
const sectionTitle = computed(() => searching.value ? '搜索结果'
  : showAll.value ? (hasFilters.value ? '筛选结果' : '全部账户') : '当前站点');
watch(visibleAccounts, (accounts) => emit('visible-accounts', accounts), { immediate: true });

function clearFilters() {
  searchQuery.value = '';
  selectedGroup.value = null;
  favoritesOnly.value = false;
}

function toggleAll() {
  showAll.value = !showAll.value;
  clearFilters();
}

function formatCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}

function getCode(secretId: string): string {
  return formatCode(props.codeData.get(secretId)?.code || '------');
}

function getRemaining(secretId: string): number {
  return props.codeData.get(secretId)?.remainingSeconds ?? 0;
}
</script>

<template>
  <div>
    <!-- 搜索框 -->
    <div v-if="secrets.length || searching" class="flex items-center gap-2 mb-3">
      <div class="relative min-w-0 flex-1">
        <svg
          class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          v-model="searchQuery"
          type="search"
          aria-label="搜索账户"
          class="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-all placeholder:text-gray-400"
          placeholder="搜索全部账户"
        >
      </div>
      <button type="button" class="shrink-0 rounded-md px-2 py-2 text-xs text-gray-500 hover:bg-gray-100 hover:text-primary-600" @click="toggleAll">
        {{ showAll ? '当前站点' : '全部账户' }}
      </button>
    </div>

    <AccountFilters
      v-if="showAll"
      v-model:group="selectedGroup"
      v-model:favorites-only="favoritesOnly"
      :groups="groups"
      :disabled="organizing"
      class="mb-3"
      @delete-group="emit('delete-group', $event)"
    />

    <section v-if="visibleAccounts.length" :aria-label="sectionTitle" class="mb-4">
      <h2 class="flex items-center justify-between text-xs font-medium text-gray-500 mb-2 px-1">
        <span>{{ sectionTitle }}</span>
        <span>{{ visibleAccounts.length }}</span>
      </h2>
      <div class="flex flex-col gap-2">
        <PopupSecretCard
          v-for="secret in visibleAccounts"
          :key="secret.id"
          :secret="secret"
          :code="getCode(secret.id)"
          :remaining="getRemaining(secret.id)"
          :organizing="organizing"
          show-delete
          @favorite="emit('favorite', $event)"
          @copy="emit('copy', $event)"
          @edit="emit('edit', $event)"
          @delete="emit('delete', $event)"
          @open-site="emit('open-site', $event)"
        />
      </div>
    </section>

    <div v-else-if="hasFilters" class="text-center py-10 px-4 text-gray-400">
      <p class="text-sm">未找到匹配结果</p>
      <button type="button" class="text-xs text-primary-600 mt-3" @click="clearFilters">清除筛选</button>
    </div>

    <p v-else-if="secrets.length" class="py-10 text-center text-sm text-gray-500">当前站点没有匹配的账户</p>

    <div v-else class="flex flex-col items-center text-center py-10 px-4">
      <h2 class="text-base font-semibold text-gray-900">添加第一个账户</h2>
      <p class="text-xs text-gray-500 mt-2 mb-5">点选网页里的二维码，或在「新增」中粘贴图片或链接。</p>
      <button type="button" class="btn-primary w-full mb-2" @click="emit('scan')">点选网页二维码</button>
      <button type="button" class="btn-secondary w-full" @click="emit('add')">新增账户</button>
    </div>
  </div>
</template>
