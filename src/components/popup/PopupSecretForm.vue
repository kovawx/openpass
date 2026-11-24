<script setup lang="ts">
import { ref, reactive, watch, onMounted } from 'vue';
import { TOTP } from '@/utils/totp';
import { generateOtp, normalizeOtpSettings, type OtpSettings } from '@/utils/otp';
import { showToast } from '@/utils/ui';
import OtpFields from '@/components/OtpFields.vue';
import AccountGroupField from '@/components/AccountGroupField.vue';

interface InitialData extends OtpSettings {
  secret: string;
  site: string;
  name: string;
  digits: number;
  group?: string;
}

interface Props {
  mode: 'create' | 'edit';
  initial: InitialData;
  groups: string[];
  saving?: boolean;
  readingQr?: boolean;
  prefilled?: boolean;
}

interface Emits {
  (e: 'submit', data: InitialData): void;
  (e: 'back'): void;
  (e: 'delete'): void;
  (e: 'quick-add', data: string | File[]): void;
  (e: 'import-backup'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const isCreate = props.mode === 'create';
const showSecret = ref(!props.prefilled);

const form = reactive<InitialData>({ ...props.initial });
const error = ref('');
const qrLink = ref('');
const qrLinkField = ref<HTMLInputElement | null>(null);

onMounted(() => qrLinkField.value?.focus());

function selectQrImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length) emit('quick-add', files);
  input.value = '';
}

// 验证码预览（仅创建模式）
const previewCode = ref('');
const previewRemaining = ref(0);
const copyingPreview = ref(false);

async function copyPreview() {
  if (!previewCode.value || copyingPreview.value) return;
  copyingPreview.value = true;
  try {
    const settings = normalizeOtpSettings(form);
    const secret = form.secret;
    const { code } = generateOtp(secret, settings);
    await TOTP.copyToClipboard(code);
    if (settings.type === 'hotp' && form.type === 'hotp' && form.secret === secret && form.counter === settings.counter) {
      form.counter = settings.counter + 1;
    }
    showToast('验证码已复制', 'success');
  } catch (error) { showToast((error as Error).message, 'error'); }
  finally { copyingPreview.value = false; }
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
  try { emit('submit', { secret, site, name, group: (form.group || '').trim(), ...normalizeOtpSettings(form) }); }
  catch (err) { error.value = (err as Error).message; }
}

if (isCreate) {
  watch(() => [form.secret, form.digits, form.algorithm, form.period, form.type, form.counter], (_, __, onCleanup) => {
    const secret = form.secret.trim().toUpperCase().replace(/\s/g, '');
    previewCode.value = '';
    if (!TOTP.isValidSecret(secret)) return;
    function refresh() {
      try {
        const result = generateOtp(secret, form);
        previewCode.value = result.code;
        previewRemaining.value = result.remainingSeconds;
      } catch { previewCode.value = ''; }
    }
    refresh();
    if (form.type !== 'hotp') {
      const timer = setInterval(refresh, 1000);
      onCleanup(() => clearInterval(timer));
    }
  }, { immediate: true });
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 页头 -->
    <div class="flex items-center gap-2 mb-3 shrink-0">
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
      <button v-if="isCreate && prefilled" type="button" class="text-xs text-gray-500 hover:text-primary-600" @click="showSecret = !showSecret">
        {{ showSecret ? '隐藏密钥' : '显示密钥' }}
      </button>
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

    <form class="flex flex-col flex-1 min-h-0" @submit.prevent="handleSubmit">
      <div class="popup-form-scroll flex flex-col gap-3.5 flex-1 min-h-0 overflow-y-auto pb-3">
        <div v-if="isCreate && !prefilled" class="form-group">
          <div class="flex items-center justify-between gap-2">
            <label for="popup-quick-add" class="form-label">识别二维码或链接</label>
            <button type="button" class="text-xs text-primary-600" @click="emit('import-backup')">导入备份</button>
          </div>
          <div class="flex gap-2">
            <input
              id="popup-quick-add"
              ref="qrLinkField"
              v-model="qrLink"
              type="text"
              class="input min-w-0"
              placeholder="粘贴图片、验证码链接或图片地址"
              autocomplete="off"
              spellcheck="false"
              :disabled="readingQr"
              @keydown.enter.prevent="qrLink.trim() && emit('quick-add', qrLink)"
            >
            <label class="btn-secondary shrink-0 cursor-pointer focus-within:ring-2">
              选图
              <input type="file" accept="image/*" class="sr-only" aria-label="选择验证码二维码图片" :disabled="readingQr" @change="selectQrImage">
            </label>
          </div>
          <p v-if="readingQr" role="status" class="text-xs text-gray-500">正在识别二维码…</p>
        </div>
        <p v-if="error && !showSecret" role="alert" class="text-xs text-red-600">{{ error }}</p>
        <!-- 密钥 -->
        <div v-if="showSecret" class="form-group">
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
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <span class="text-[11px] text-gray-500">验证码预览</span>
            <button type="button" class="text-xs text-primary-600" title="复制预览验证码" :disabled="copyingPreview || saving" @click="copyPreview">复制验证码</button>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xl font-bold font-mono text-primary-600">{{ TOTP.formatCode(previewCode) }}</span>
            <span class="text-xs font-semibold text-primary-600 bg-primary-100 px-2 py-0.5 rounded-full">
              {{ form.type === 'hotp' ? `计数器 ${form.counter ?? 0}` : `${previewRemaining}s` }}
            </span>
          </div>
          <p class="text-[11px] text-gray-500 mt-2">可直接复制验证码。需要以后继续使用时，再保存密钥。</p>
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

        <AccountGroupField v-model="form.group" :groups="groups" />
        <details :open="!isCreate" class="otp-advanced rounded-lg border border-gray-200 bg-white text-sm text-gray-700">
          <summary class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 font-medium hover:bg-gray-50">
            验证码高级选项
          </summary>
          <div class="border-t border-gray-100 p-3">
            <OtpFields :settings="form" @update="Object.assign(form, $event)" />
          </div>
        </details>
        <p v-if="form.type === 'hotp'" class="text-xs text-gray-500">预览不递增计数器；复制或填充后自动递增。</p>
      </div>
      <div class="shrink-0 pt-3 border-t border-gray-200">
        <button type="submit" class="btn-primary w-full" :disabled="saving || readingQr || copyingPreview">
          {{ saving ? '保存中…' : isCreate ? '保存密钥' : '保存修改' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.popup-form-scroll {
  margin-inline-end: -8px;
  padding-inline-end: 8px;
  overscroll-behavior-y: contain;
  scrollbar-width: thin;
  scrollbar-color: #cbd5e1 transparent;
}

.popup-form-scroll:hover {
  scrollbar-color: #94a3b8 transparent;
}

.otp-advanced > summary {
  list-style: none;
  border-radius: inherit;
}

.otp-advanced > summary::-webkit-details-marker {
  display: none;
}

.otp-advanced > summary::after {
  content: '';
  width: 6px;
  height: 6px;
  margin-inline-end: 2px;
  border-block-end: 1.5px solid #64748b;
  border-inline-end: 1.5px solid #64748b;
  transform: translateY(-2px) rotate(45deg);
}

.otp-advanced[open] > summary::after {
  transform: translateY(2px) rotate(225deg);
}
</style>
