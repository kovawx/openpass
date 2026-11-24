<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

interface Emits {
  (e: 'add'): void;
  (e: 'scan'): void;
  (e: 'about'): void;
  (e: 'manage'): void;
}

const emit = defineEmits<Emits>();

const showMenu = ref(false);

function handleGlobalClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('.popup-dropdown')) {
    showMenu.value = false;
  }
}

onMounted(() => document.addEventListener('click', handleGlobalClick));
onUnmounted(() => document.removeEventListener('click', handleGlobalClick));
</script>

<template>
  <header class="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 shrink-0 relative z-10">
    <h1 class="text-base font-semibold text-gray-900">OpenPass</h1>

    <div class="flex gap-1">
      <!-- 点选二维码 -->
      <button
        type="button"
        class="flex items-center justify-center gap-1 px-2 h-9 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-primary-600 transition-colors"
        title="点选网页二维码"
        aria-label="点选二维码"
        @click="emit('scan')"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 7V5a2 2 0 0 1 2-2h2" />
          <path d="M17 3h2a2 2 0 0 1 2 2v2" />
          <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
          <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
          <rect x="7" y="7" width="3" height="3" />
          <rect x="14" y="7" width="3" height="3" />
          <rect x="7" y="14" width="3" height="3" />
          <path d="M14 14h3v3h-3z" />
        </svg>
        <span class="text-sm font-medium">点选二维码</span>
      </button>

      <!-- 添加 -->
      <button
        type="button"
        class="flex items-center justify-center gap-1 px-2 h-9 rounded-lg text-primary-600 hover:bg-primary-50 transition-colors"
        title="添加密钥"
        aria-label="新增账户"
        @click="emit('add')"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <span class="text-sm font-medium">新增</span>
      </button>

      <!-- 更多操作 -->
      <div class="relative popup-dropdown" @click.stop>
        <button
          type="button"
          class="flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-primary-600 transition-colors"
          title="更多操作"
          aria-label="更多操作"
          :aria-expanded="showMenu"
          @keydown.esc="showMenu = false"
          @click="showMenu = !showMenu"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
            <circle cx="5" cy="12" r="1" />
          </svg>
        </button>

        <div
          v-show="showMenu"
          class="absolute right-0 top-full mt-1 min-w-[160px] py-1.5 bg-white border border-gray-100 rounded-lg shadow-lg z-[100]"
        >
          <button
            type="button"
            class="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
            @click="showMenu = false; emit('about')"
          >
            <svg class="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>关于</span>
          </button>

          <div class="h-px bg-gray-100 my-1.5" />

          <button
            type="button"
            class="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
            aria-label="打开管理页面"
            @click="showMenu = false; emit('manage')"
          >
            <svg class="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
            <span class="text-left">打开管理页面<small class="block text-[11px] text-gray-400 mt-0.5">账户管理、备份与配置</small></span>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>
