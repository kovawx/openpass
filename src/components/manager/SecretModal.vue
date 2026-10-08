<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useSecretStore, type Secret } from '@/stores/secrets';
import { TOTP } from '@/utils/totp';
import { normalizeOtpSettings } from '@/utils/otp';
import OtpFields from '@/components/OtpFields.vue';

interface Props {
  open: boolean;
  editingSecret?: Secret | null;
}

interface Emits {
  (e: 'close'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const secretStore = useSecretStore();

const site = ref('');
const name = ref('');
const secretKey = ref('');
const otpSettings = ref(normalizeOtpSettings({}));
const error = ref('');
const submitting = ref(false);

const isEditing = computed(() => !!props.editingSecret);

watch(() => props.editingSecret, (val) => {
  if (val) {
    site.value = val.site;
    name.value = val.name || '';
    secretKey.value = val.secret;
    otpSettings.value = normalizeOtpSettings(val);
  } else {
    resetForm();
  }
}, { immediate: true });

watch(() => props.open, (val) => {
  if (val && !props.editingSecret) {
    resetForm();
  }
});

function resetForm() {
  site.value = '';
  name.value = '';
  secretKey.value = '';
  otpSettings.value = normalizeOtpSettings({});
  error.value = '';
  submitting.value = false;
}

function handleSecretInput() {
  const value = secretKey.value.toUpperCase().replace(/[^A-Z2-7=]/g, '');
  secretKey.value = value;

  if (value && !TOTP.isValidSecret(value)) {
    error.value = '密钥格式无效（至少需要 16 个 Base32 字符）';
  } else if (value) {
    error.value = '';
  }
}

async function handleSubmit() {
  if (!site.value) {
    error.value = '请输入站点名称';
    return;
  }

  if (!TOTP.isValidSecret(secretKey.value)) {
    error.value = '请输入有效的密钥（至少 16 个 Base32 字符）';
    return;
  }

  submitting.value = true;
  error.value = '';

  try {
    if (isEditing.value && props.editingSecret) {
      await secretStore.updateSecret(props.editingSecret.id, {
        site: site.value.toLowerCase(),
        name: name.value,
        secret: secretKey.value,
        ...normalizeOtpSettings(otpSettings.value)
      }, props.editingSecret);
    } else {
      await secretStore.addSecret({
        site: site.value.toLowerCase(),
        name: name.value,
        secret: secretKey.value,
        ...normalizeOtpSettings(otpSettings.value)
      });
    }

    emit('close');
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    submitting.value = false;
  }
}

function handleClose() {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="handleClose">
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="text-lg font-semibold text-gray-900">
            {{ isEditing ? '编辑密钥' : '添加密钥' }}
          </h3>
        </div>

        <form @submit.prevent="handleSubmit">
          <div class="modal-body space-y-4">
            <div class="form-group">
              <label for="site" class="form-label">
                站点 <span class="text-red-500">*</span>
              </label>
              <input
                id="site"
                v-model="site"
                type="text"
                placeholder="例如: github.com"
                class="input"
                required
                autofocus
              />
            </div>

            <div class="form-group">
              <label for="name" class="form-label">名称（可选）</label>
              <input
                id="name"
                v-model="name"
                type="text"
                placeholder="自定义名称"
                class="input"
              />
            </div>

            <div class="form-group">
              <label for="secretKey" class="form-label">
                密钥 <span class="text-red-500">*</span>
              </label>
              <input
                id="secretKey"
                v-model="secretKey"
                type="text"
                placeholder="Base32 编码的密钥"
                class="input"
                required
                @input="handleSecretInput"
              />
              <p class="mt-1 text-xs text-gray-500">
                从网站获取的 16+ 字符 Base32 密钥
              </p>
            </div>

            <OtpFields :settings="otpSettings" @update="Object.assign(otpSettings, $event)" />

            <p v-if="error" class="text-sm text-red-600 bg-red-50 p-3 rounded">{{ error }}</p>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" @click="handleClose">
              取消
            </button>
            <button
              type="submit"
              class="btn-primary"
              :disabled="submitting"
            >
              {{ submitting ? '保存中...' : (isEditing ? '保存' : '添加') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
