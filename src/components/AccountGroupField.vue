<script setup lang="ts">
import { computed, useId } from 'vue';
const props = defineProps<{ modelValue?: string; groups: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
const group = computed({ get: () => props.modelValue || '', set: (value) => emit('update:modelValue', value) });
</script>

<template>
  <div class="form-group" @keydown.stop>
    <label :for="id" class="form-label">分组（可选）</label>
    <input :id="id" v-model="group" type="text" class="input" :list="`${id}-groups`" placeholder="未分组" autocomplete="off" />
    <datalist :id="`${id}-groups`">
      <option v-for="name in groups" :key="name" :value="name" />
    </datalist>
    <span class="text-xs text-gray-400">选择已有分组或输入新名称</span>
  </div>
</template>
