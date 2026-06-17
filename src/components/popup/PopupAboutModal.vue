<script setup lang="ts">
interface Props {
  open: boolean;
  version: string;
}

interface Emits {
  (e: 'close'): void;
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content max-w-[320px]">
      <div class="modal-header flex items-center justify-between">
        <h3 class="text-base font-semibold text-gray-900">关于 OpenPass</h3>
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          @click="emit('close')"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <p class="text-sm text-gray-600 mb-4">
          OpenPass 是一款开源的两步验证管理器扩展，帮助你安全管理 TOTP 验证码。
        </p>

        <div class="flex justify-between py-2">
          <span class="text-[13px] text-gray-400">版本</span>
          <span class="text-[13px] font-medium text-gray-900">v{{ version }}</span>
        </div>

        <div class="flex gap-3 mt-4">
          <a
            href="https://github.com/kovawx/openpass"
            target="_blank"
            class="inline-flex items-center gap-1.5 text-[13px] text-primary-600 hover:text-primary-700 hover:underline"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.835 1.305 3.54.99.105-.78.42-1.305.765-1.605-2.67-.3-5.47-1.33-5.47-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.47 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
