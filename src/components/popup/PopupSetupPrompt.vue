<script setup lang="ts">
interface Emits {
  (e: 'setup'): void;
}

const emit = defineEmits<Emits>();
</script>

<template>
  <div class="flex flex-col items-center justify-center min-h-[480px] px-5 py-10 text-center">
    <div class="mb-4 text-primary-600">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>
    <h2 class="text-lg font-semibold text-gray-900 mb-2">欢迎使用 OpenPass</h2>
    <p class="text-sm text-gray-600 mb-5">请先设置主密码以保护你的密钥</p>
    <button type="button" class="btn-primary" @click="emit('setup')">设置主密码</button>
  </div>
</template>
