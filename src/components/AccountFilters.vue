<script setup lang="ts">
import { computed, watch } from 'vue';

const props = defineProps<{ groups: string[]; group: string | null; favoritesOnly: boolean; disabled?: boolean }>();
const emit = defineEmits<{
  'update:group': [value: string | null];
  'update:favoritesOnly': [value: boolean];
  'delete-group': [group: string];
}>();
const selectedGroup = computed({ get: () => props.group, set: (value) => emit('update:group', value) });
const onlyFavorites = computed({ get: () => props.favoritesOnly, set: (value) => emit('update:favoritesOnly', value) });
watch(() => props.groups, (groups) => {
  if (props.group && !groups.includes(props.group)) emit('update:group', null);
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-sm" @keydown.stop>
    <select v-model="selectedGroup" aria-label="分组筛选" class="input flex-1 min-w-0" :disabled="disabled">
      <option :value="null">全部分组</option>
      <option value="">未分组</option>
      <option v-for="name in groups" :key="name" :value="name">{{ name }}</option>
    </select>
    <label class="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer whitespace-nowrap">
      <input v-model="onlyFavorites" type="checkbox" :disabled="disabled" class="accent-primary-600" />
      仅看收藏
    </label>
    <button v-if="group" type="button" class="text-xs text-gray-500 hover:text-red-600" :disabled="disabled" @click="emit('delete-group', group)">
      删除分组
    </button>
  </div>
</template>
