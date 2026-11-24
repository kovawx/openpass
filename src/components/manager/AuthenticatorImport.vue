<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { AuthenticatorPasswordError, MAX_AUTHENTICATOR_BACKUP_SIZE, parseAuthenticatorImport,
  type AuthenticatorImport } from '@/utils/authenticatorImport';
import { classifyOtpQrInput } from '@/utils/otpQrInput';
import { showToast } from '@/utils/ui';
import { clipboardImages, decodeQrBlob } from '@/utils/qrBlob';

const props = defineProps<{
  initialLinks?: string;
  initialPreview?: AuthenticatorImport;
  needsUnlock?: boolean;
  submitOnMount?: boolean;
}>();
const emit = defineEmits<{ close: []; 'request-unlock': [preview: AuthenticatorImport] }>();
const initialInput = props.initialLinks ?? '';
const fromClipboard = initialInput.trimStart().startsWith('{');
const links = ref(fromClipboard ? '' : initialInput);
const fileName = ref(fromClipboard ? '剪贴板备份' : '');
const backupText = ref<string | null>(fromClipboard ? initialInput : null);
const password = ref('');
const needsPassword = ref(false);
const reading = ref(false);
const checking = ref(false);
const importing = ref(false);
const fileError = ref('');
const importError = ref('');
const preview = ref<AuthenticatorImport | null>(props.initialPreview ?? null);
const input = computed(() => backupText.value ?? links.value);
let previewRevision = 0;

async function inspect(backupPassword?: string) {
  const revision = ++previewRevision;
  preview.value = null;
  if (!backupPassword) needsPassword.value = false;
  importError.value = '';
  if (!input.value.trim()) {
    checking.value = false;
    return;
  }
  checking.value = true;
  try {
    const parsed = await parseAuthenticatorImport(input.value, backupPassword);
    if (revision !== previewRevision) return;
    preview.value = parsed;
    needsPassword.value = false;
    password.value = '';
  } catch (error) {
    if (revision !== previewRevision) return;
    needsPassword.value = error instanceof AuthenticatorPasswordError;
    if (backupPassword || !needsPassword.value) importError.value = (error as Error).message;
  } finally {
    if (revision === previewRevision) checking.value = false;
  }
}

watch(input, () => {
  password.value = '';
  void inspect();
});

async function readFiles(files: File[]) {
  if (reading.value || importing.value || !files.length) return;
  reading.value = true;
  fileError.value = '';
  try {
    const backups = files.filter(file => !file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(file.name));
    if (backups.length) {
      if (files.length !== 1) throw new Error('请一次选择一个备份文件，或选择多张二维码图片');
      const [file] = backups;
      if (file.size > MAX_AUTHENTICATOR_BACKUP_SIZE) throw new Error('备份文件过大，请分批导入');
      backupText.value = await file.text();
      fileName.value = file.name;
      return;
    }
    const decoded: string[] = [];
    let failures = 0;
    for (const file of files) {
      try {
        const text = await decodeQrBlob(file, value => classifyOtpQrInput(value) ? value : null);
        if (text) decoded.push(text);
        else failures++;
      } catch { failures++; }
    }
    if (decoded.length) {
      backupText.value = null;
      fileName.value = '';
      links.value = [...new Set([links.value.trim(), ...decoded].filter(Boolean))].join('\n');
    }
    if (failures) fileError.value = `有 ${failures} 张图片未识别到验证器二维码`;
  } catch (error) { fileError.value = (error as Error).message; }
  finally { reading.value = false; }
}

function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  void readFiles(Array.from(input.files ?? []));
  input.value = '';
}

function pasteImage(event: ClipboardEvent) {
  if (!event.clipboardData) return;
  const images = clipboardImages(event.clipboardData);
  if (!images.length) return;
  event.preventDefault();
  void readFiles(images);
}

function clearFile() {
  backupText.value = null;
  fileName.value = '';
  fileError.value = '';
}

async function submit() {
  if (importing.value || reading.value || checking.value) return;
  if (needsPassword.value && password.value) {
    await inspect(password.value);
    return;
  }
  const result = preview.value;
  if (!result?.accounts.length || result.missingImages) return;
  if (props.needsUnlock) {
    emit('request-unlock', result);
    return;
  }
  importing.value = true;
  importError.value = '';
  try {
    const response = await chrome.runtime.sendMessage({ action: 'importAuthenticatorAccounts', accounts: result.accounts });
    if (!response?.success) throw new Error(response?.error || '导入失败');
    const summary = `已导入 ${response.imported} 个账户${response.skipped ? `，跳过 ${response.skipped} 个重复账户` : ''}`;
    showToast(response.warning ? `${summary}。${response.warning}` : summary, response.warning ? 'warning' : 'success');
    emit('close');
  } catch (error) { importError.value = (error as Error).message; }
  finally { importing.value = false; }
}

onMounted(() => {
  if (props.submitOnMount) void submit();
  else if (input.value) void inspect();
});

function close() {
  if (!importing.value) emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="close" @keydown.esc="close">
      <section class="modal-content" role="dialog" aria-modal="true" aria-labelledby="migration-title">
        <header class="modal-header">
          <h3 id="migration-title" class="text-lg font-semibold text-gray-900">导入验证器账户</h3>
        </header>
        <form @submit.prevent="submit">
          <div class="modal-body space-y-4">
            <div v-if="!initialPreview" class="form-group">
              <p v-if="fileName" class="flex items-center justify-between gap-2 text-sm">
                <span class="break-all">{{ fileName }}</span>
                <button type="button" class="shrink-0 text-primary-600" @click="clearFile">移除</button>
              </p>
              <template v-else>
                <label for="migration-links" class="form-label">链接或二维码</label>
                <textarea
                  id="migration-links"
                  v-model="links"
                  class="input font-mono text-sm resize-y"
                  rows="3"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="粘贴验证码链接、迁移链接或二维码截图"
                  :disabled="reading || importing"
                  @paste="pasteImage"
                  @keydown.enter.stop
                  @input="fileError = ''"
                />
              </template>
              <input
                id="authenticator-import-file"
                type="file"
                accept="image/*,.json,.2fas,.txt"
                multiple
                class="mt-2 max-w-full text-sm"
                aria-label="选择二维码或验证器备份文件"
                :disabled="reading || importing || checking"
                @change="selectFiles"
              />
            </div>
            <div v-if="needsPassword" class="form-group">
              <label for="authenticator-backup-password" class="form-label">备份密码</label>
              <input
                id="authenticator-backup-password"
                v-model="password"
                type="password"
                class="input"
                autocomplete="off"
                :disabled="checking"
                @input="importError = ''"
              />
            </div>
            <p v-if="reading || checking" role="status" class="text-sm text-gray-500">正在读取导入数据…</p>
            <p v-if="fileError" role="alert" class="text-sm text-red-600">{{ fileError }}</p>
            <p v-if="importError" role="alert" class="text-sm text-red-600">{{ importError }}</p>
            <div v-if="preview" class="space-y-2 text-sm text-gray-700">
              <p role="status">
                {{ preview.source }} · {{ preview.accounts.length }} 个可导入账户
                <span v-if="preview.missingImages" class="text-amber-700">，还缺少 {{ preview.missingImages }} 张二维码</span>
              </p>
              <ul v-if="preview.accounts.length" class="max-h-40 space-y-1 overflow-y-auto rounded-md bg-gray-50 p-3">
                <li v-for="(account, index) in preview.accounts" :key="index" class="break-all">
                  {{ account.name }} <span class="text-xs text-gray-500">{{ account.type?.toUpperCase() }} · {{ account.digits }} 位</span>
                </li>
              </ul>
              <details v-if="preview.omitted.length" class="text-amber-800" :open="!preview.accounts.length">
                <summary>有 {{ preview.omitted.length }} 个账户无法导入</summary>
                <ul class="max-h-28 space-y-1 overflow-y-auto pt-1">
                  <li v-for="(entry, index) in preview.omitted" :key="index" class="break-all">{{ entry.name }} · {{ entry.reason }}</li>
                </ul>
              </details>
            </div>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn-secondary" :disabled="importing" @click="close">取消</button>
            <button
              type="submit"
              class="btn-primary"
              :disabled="importing || reading || checking || (needsPassword ? !password : !preview?.accounts.length || !!preview.missingImages)"
            >{{ importing ? '导入中…' : needsPassword ? '读取备份' : needsUnlock ? '解锁并导入' : '导入账户' }}</button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>
