<script setup lang="ts">
interface Props {
  open: boolean;
  message: string;
}

interface Emits {
  (e: 'close'): void;
  (e: 'repair'): void;
}

defineProps<Props>();
const emit = defineEmits<Emits>();
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content max-w-[300px]">
      <div class="modal-header flex items-center justify-between">
        <h3 class="text-base font-semibold text-gray-900">数据修复</h3>
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
          {{ message || '检测到 popup 数据需要同步，请打开管理后台处理。' }}
        </p>

        <div class="flex justify-end gap-3">
          <button type="button" class="btn-secondary" @click="emit('close')">关闭</button>
          <button type="button" class="btn-primary" @click="emit('repair')">打开管理后台</button>
        </div>
      </div>
    </div>
  </div>
</template>
