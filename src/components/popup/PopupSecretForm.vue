<script setup lang="ts">
import { ref, reactive, watch, onUnmounted } from 'vue';
import { TOTP } from '@/utils/totp';

type TimerHandle = ReturnType<typeof setInterval>;

interface InitialData {
  secret: string;
  site: string;
  name: string;
  digits: number;
}

interface Props {
  mode: 'create' | 'edit';
  initial: InitialData;
}

interface Emits {
  (e: 'submit', data: InitialData): void;
  (e: 'back'): void;
  (e: 'delete'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const isCreate = props.mode === 'create';

const form = reactive<InitialData>({ ...props.initial });
const error = ref('');

// 验证码预览（仅创建模式）
const previewCode = ref('');
const previewRemaining = ref(0);
let previewTimer: TimerHandle | null = null;

function stopPreviewTimer() {
  if (previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
}

async function updatePreview() {
  if (!isCreate) return;

  const secret = form.secret.trim().toUpperCase().replace(/\s/g, '');
  if (!secret) {
    previewCode.value = '';
    stopPreviewTimer();
    return;
  }

  try {
    const result = await TOTP.generateCode(secret, form.digits);
    previewCode.value = formatCode(result.code);
    previewRemaining.value = result.remainingSeconds;

    stopPreviewTimer();
    previewTimer = setInterval(async () => {
      try {
        const r = await TOTP.generateCode(secret, form.digits);
        previewCode.value = formatCode(r.code);
        previewRemaining.value = r.remainingSeconds;
      } catch {
        previewCode.value = '';
      }
    }, 1000);
  } catch {
    previewCode.value = '';
  }
}

function formatCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}

// 密钥输入格式化
function formatSecretInput() {
  form.secret = form.secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (form.secret && !TOTP.isValidSecret(form.secret)) {
    error.value = '密钥格式无效（至少需要 16 个字符）';
  } else {
    error.value = '';
  }
}

function handleSubmit() {
  const secret = form.secret.trim().toUpperCase().replace(/\s/g, '');
  const site = form.site.trim().toLowerCase();
  const name = form.name.trim();

  if (!TOTP.isValidSecret(secret)) {
    error.value = '密钥格式无效（至少需要 16 个字符）';
    return;
  }

  if (isCreate && !site) {
    error.value = '请输入目标站点';
    return;
  }

  error.value = '';
  emit('submit', { secret, site, name, digits: form.digits });
}

if (isCreate) {
  watch(() => form.secret, updatePreview);
  watch(() => form.digits, updatePreview);
}

onUnmounted(stopPreviewTimer);
</script>

<template>
  <div>
    <!-- 页头 -->
    <div class="flex items-center gap-2 mb-4">
      <button
        type="button"
        class="flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        title="返回"
        @click="emit('back')"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <h2 class="flex-1 text-base font-semibold text-gray-900">
        {{ isCreate ? '添加密钥' : '编辑密钥' }}
      </h2>
      <button
        v-if="!isCreate"
        type="button"
        class="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
        title="删除"
        @click="emit('delete')"
      >
        <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>

    <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
      <!-- 密钥 -->
      <div class="form-group">
        <label class="form-label">密钥</label>
        <input
          v-model="form.secret"
          type="text"
          class="input font-mono"
          placeholder="输入密钥"
          autocomplete="off"
          spellcheck="false"
          @input="formatSecretInput"
        >
        <span v-if="isCreate" class="text-[11px] text-gray-400">
          支持标准 TOTP 密钥格式，例如：JBSWY3DPEHPK3PXP
        </span>
        <span class="text-[11px] text-red-600 min-h-[16px]">{{ error }}</span>
      </div>

      <!-- 预览（仅创建） -->
      <div v-if="isCreate && previewCode" class="bg-primary-50 rounded-lg px-3 py-2.5">
        <div class="text-[11px] text-gray-500 mb-1.5">验证码预览</div>
        <div class="flex items-center justify-between">
          <span class="text-xl font-bold font-mono text-primary-600">{{ previewCode }}</span>
          <span class="text-xs font-semibold text-primary-600 bg-primary-100 px-2 py-0.5 rounded-full">
            {{ previewRemaining }}s
          </span>
        </div>
      </div>

      <!-- 验证码长度 -->
      <div class="form-group">
        <label class="form-label">验证码长度</label>
        <select v-model.number="form.digits" class="input">
          <option :value="6">6 位</option>
          <option :value="8">8 位</option>
        </select>
      </div>

      <!-- 目标站点 -->
      <div class="form-group">
        <label class="form-label">目标站点</label>
        <input
          v-model="form.site"
          type="text"
          class="input"
          placeholder="例如: github.com"
          autocomplete="off"
        >
        <span v-if="isCreate" class="text-[11px] text-gray-400">支持完整 URL 或域名匹配</span>
      </div>

      <!-- 名称 -->
      <div class="form-group">
        <label class="form-label">名称（可选）</label>
        <input
          v-model="form.name"
          type="text"
          class="input"
          placeholder="例如: GitHub"
          autocomplete="off"
        >
      </div>

      <button type="submit" class="btn-primary w-full">
        {{ isCreate ? '保存密钥' : '保存修改' }}
      </button>
    </form>
  </div>
</template>
