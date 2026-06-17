<script setup lang="ts">
import { computed } from 'vue';
import type { Secret } from '@/stores/secrets';

interface Props {
  secret: Secret;
  /** 已格式化的验证码，例如 "123 456" */
  code: string;
  /** 剩余秒数 */
  remaining: number;
  /** 是否显示删除按钮（搜索结果列表用） */
  showDelete?: boolean;
}

interface Emits {
  (e: 'copy', secret: Secret): void;
  (e: 'edit', secret: Secret): void;
  (e: 'delete', secret: Secret): void;
  (e: 'open-site', secret: Secret): void;
}

const props = withDefaults(defineProps<Props>(), {
  showDelete: false
});
const emit = defineEmits<Emits>();

const progress = computed(() => `${(props.remaining / 30) * 100}%`);
const isWarning = computed(() => props.remaining <= 10);
const isDanger = computed(() => props.remaining <= 5);
</script>

<template>
  <div
    class="group bg-white rounded-lg border border-gray-100 shadow-sm p-3.5 cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0"
    @click="emit('copy', secret)"
  >
    <!-- 头部：名称 + 站点 + 操作 -->
    <div class="flex items-start justify-between mb-2.5">
      <div class="flex-1 min-w-0">
        <div
          class="text-sm font-semibold text-gray-900 truncate hover:text-primary-600 transition-colors"
          :title="secret.name || secret.site"
          @click.stop="emit('open-site', secret)"
        >{{ secret.name || secret.site }}</div>
        <div
          class="text-xs text-gray-400 truncate hover:text-primary-600 transition-colors"
          :title="secret.site"
          @click.stop="emit('open-site', secret)"
        >{{ secret.site }}</div>
      </div>

      <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          title="编辑"
          @click.stop="emit('edit', secret)"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button
          v-if="showDelete"
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
          title="删除"
          @click.stop="emit('delete', secret)"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 验证码 + 倒计时 -->
    <div class="flex items-center justify-between">
      <span class="text-[26px] font-bold tracking-wide font-mono text-primary-600 select-none">
        {{ code }}
      </span>
      <span
        class="relative overflow-hidden min-w-[36px] text-xs font-semibold px-2.5 py-1 rounded-xl flex items-center gap-1"
        :class="isDanger
          ? 'text-red-600 bg-red-50 animate-pulse'
          : isWarning
            ? 'text-yellow-600 bg-yellow-50'
            : 'text-primary-600 bg-primary-50'"
      >
        <span
          class="absolute inset-y-0 left-0 opacity-15 transition-[width] duration-1000 ease-linear"
          :class="isDanger ? 'bg-red-500' : isWarning ? 'bg-yellow-500' : 'bg-primary-600'"
          :style="{ width: progress }"
        />
        <span class="relative z-10">{{ remaining }}s</span>
      </span>
    </div>
  </div>
</template>
