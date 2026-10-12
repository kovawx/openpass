<script setup lang="ts">
defineProps<{ favorite?: boolean; disabled?: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="inline-flex shrink-0 items-center justify-center w-7 h-7 rounded-md hover:bg-gray-100 transition-colors disabled:opacity-50"
    :class="favorite ? 'text-amber-500' : 'text-gray-400 hover:text-amber-500'"
    :title="favorite ? '取消收藏' : '收藏'"
    :aria-label="favorite ? '取消收藏' : '收藏'"
    :aria-pressed="favorite === true"
    :disabled="disabled"
    @click.stop="$emit('toggle')"
    @keydown.stop
  >
    <svg class="w-4 h-4" viewBox="0 0 24 24" :fill="favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3Z" />
    </svg>
  </button>
</template>
