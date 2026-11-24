<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Check, ChevronDown } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getErrorMessage } from '@/utils/error';
import { recordRuntimeError } from '@/utils/runtimeErrors';
import { showToast } from '@/utils/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

interface Emits {
  (e: 'close'): void;
  (e: 'navigate', page: string): void;
}

interface StepStatus {
  completed: boolean;
  label: string;
}

const emit = defineEmits<Emits>();
const authStore = useAuthStore();

const welcomePassword = ref('');
const welcomePasswordConfirm = ref('');
const welcomePasswordError = ref('');
const passwordSubmitting = ref(false);
const expandedStep = ref<'step1' | 'step2' | 'step3'>('step1');

const steps = reactive<Record<'step1' | 'step2' | 'step3', StepStatus>>({
  step1: { completed: false, label: '设置主密码' },
  step2: { completed: false, label: '添加第一个密钥' },
  step3: { completed: false, label: '配置自动备份' }
});

onMounted(async () => {
  await checkGuideStatus();
});

async function checkGuideStatus() {
  try {
    const result = await chrome.storage.local.get<{
      masterPasswordHash?: string;
      isSetupComplete?: boolean;
      sitesList?: unknown[];
      enableAutoBackup?: boolean;
    }>(['masterPasswordHash', 'isSetupComplete', 'sitesList', 'enableAutoBackup']);

    steps.step1.completed = result.isSetupComplete === true || !!result.masterPasswordHash;
    steps.step2.completed = Array.isArray(result.sitesList) && result.sitesList.length > 0;
    steps.step3.completed = !!result.enableAutoBackup;

    if (!steps.step1.completed) {
      expandedStep.value = 'step1';
    } else if (!steps.step2.completed) {
      expandedStep.value = 'step2';
    } else if (!steps.step3.completed) {
      expandedStep.value = 'step3';
    }
  } catch (error) {
    await recordRuntimeError({
      scope: 'options:welcome-guide',
      error,
      details: 'checkGuideStatus'
    });
    showToast(`引导状态读取失败: ${getErrorMessage(error)}`, 'error');
  }
}

async function handleSetPassword() {
  if (!welcomePassword.value) {
    welcomePasswordError.value = '请输入主密码';
    return;
  }

  if (welcomePassword.value.length < 6) {
    welcomePasswordError.value = '密码至少需要 6 个字符';
    return;
  }

  if (welcomePassword.value !== welcomePasswordConfirm.value) {
    welcomePasswordError.value = '两次输入的密码不一致';
    return;
  }

  passwordSubmitting.value = true;

  try {
    await authStore.initializeVault(welcomePassword.value);

    steps.step1.completed = true;
    expandedStep.value = 'step2';
    welcomePassword.value = '';
    welcomePasswordConfirm.value = '';
    welcomePasswordError.value = '';

    showToast('主密码设置成功', 'success');
  } catch (error) {
    await recordRuntimeError({
      scope: 'options:welcome-guide',
      error,
      details: 'handleSetPassword'
    });
    welcomePasswordError.value = `设置失败: ${getErrorMessage(error)}`;
  } finally {
    passwordSubmitting.value = false;
  }
}

async function completeAndClose(details: string) {
  try {
    await chrome.storage.local.set({ welcomeCompleted: true });
    emit('close');
  } catch (error) {
    await recordRuntimeError({
      scope: 'options:welcome-guide',
      error,
      details
    });
    showToast(`欢迎引导操作失败: ${getErrorMessage(error)}`, 'error');
  }
}

async function handleSkip() {
  await completeAndClose('handleSkip');
}

async function handleStartUsing() {
  await completeAndClose('handleStartUsing');
}

function toggleStep(step: 'step1' | 'step2' | 'step3') {
  if (steps[step].completed) {
    return;
  }

  expandedStep.value = step;
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-4">
      <Card class="max-h-[90vh] w-full max-w-lg overflow-y-auto" @click.stop>
        <CardHeader>
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <svg class="h-5 w-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div>
              <CardTitle>欢迎使用 OpenPass</CardTitle>
              <p class="text-sm text-muted-foreground">只需 3 步即可完成基础设置。</p>
            </div>
          </div>
        </CardHeader>

        <CardContent class="space-y-3">
          <div class="rounded-lg border transition-all" :class="expandedStep === 'step1' ? 'border-primary bg-primary/5' : 'border-border'">
            <button
              type="button"
              class="flex w-full items-center justify-between px-4 py-3 text-left"
              @click="toggleStep('step1')"
            >
              <div class="flex items-center gap-3">
                <div
                  class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
                  :class="steps.step1.completed ? 'bg-green-500 text-white' : 'bg-primary text-primary-foreground'"
                >
                  <Check v-if="steps.step1.completed" class="h-3 w-3" />
                  <span v-else>1</span>
                </div>
                <span class="font-medium">{{ steps.step1.label }}</span>
                <span
                  class="rounded px-2 py-0.5 text-xs"
                  :class="steps.step1.completed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
                >
                  {{ steps.step1.completed ? '已完成' : '必做' }}
                </span>
              </div>
              <ChevronDown class="h-5 w-5 text-muted-foreground transition-transform" :class="{ 'rotate-180': expandedStep === 'step1' && !steps.step1.completed }" />
            </button>

            <div v-if="expandedStep === 'step1' && !steps.step1.completed" class="space-y-4 border-t px-4 pb-4 pt-4">
              <div class="space-y-2">
                <Label for="welcome-password">主密码</Label>
                <Input
                  id="welcome-password"
                  v-model="welcomePassword"
                  type="password"
                  placeholder="至少 6 个字符"
                />
              </div>
              <div class="space-y-2">
                <Label for="welcome-password-confirm">确认密码</Label>
                <Input
                  id="welcome-password-confirm"
                  v-model="welcomePasswordConfirm"
                  type="password"
                  placeholder="再次输入主密码"
                />
              </div>
              <p v-if="welcomePasswordError" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {{ welcomePasswordError }}
              </p>
              <Button class="w-full" :disabled="passwordSubmitting" @click="handleSetPassword">
                {{ passwordSubmitting ? '设置中...' : '设置主密码' }}
              </Button>
            </div>
          </div>

          <div class="rounded-lg border transition-all" :class="expandedStep === 'step2' && !steps.step2.completed ? 'border-primary bg-primary/5' : 'border-border'">
            <button
              type="button"
              class="flex w-full items-center justify-between px-4 py-3 text-left"
              @click="toggleStep('step2')"
            >
              <div class="flex items-center gap-3">
                <div
                  class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
                  :class="steps.step2.completed ? 'bg-green-500 text-white' : 'bg-muted text-muted-foreground'"
                >
                  <Check v-if="steps.step2.completed" class="h-3 w-3" />
                  <span v-else>2</span>
                </div>
                <span class="font-medium">{{ steps.step2.label }}</span>
                <span class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">推荐</span>
              </div>
              <ChevronDown class="h-5 w-5 text-muted-foreground transition-transform" :class="{ 'rotate-180': expandedStep === 'step2' && !steps.step2.completed }" />
            </button>

            <div v-if="expandedStep === 'step2' && !steps.step2.completed" class="border-t px-4 pb-4 pt-4">
              <p class="mb-3 text-sm text-muted-foreground">从支持 2FA 的网站获取密钥后，先添加第一条记录。</p>
              <Button variant="secondary" class="w-full" @click="emit('navigate', 'secrets:add')">去添加密钥</Button>
            </div>
          </div>

          <div class="rounded-lg border transition-all" :class="expandedStep === 'step3' && !steps.step3.completed ? 'border-primary bg-primary/5' : 'border-border'">
            <button
              type="button"
              class="flex w-full items-center justify-between px-4 py-3 text-left"
              @click="toggleStep('step3')"
            >
              <div class="flex items-center gap-3">
                <div
                  class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
                  :class="steps.step3.completed ? 'bg-green-500 text-white' : 'bg-muted text-muted-foreground'"
                >
                  <Check v-if="steps.step3.completed" class="h-3 w-3" />
                  <span v-else>3</span>
                </div>
                <span class="font-medium">{{ steps.step3.label }}</span>
                <span class="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">推荐</span>
              </div>
              <ChevronDown class="h-5 w-5 text-muted-foreground transition-transform" :class="{ 'rotate-180': expandedStep === 'step3' && !steps.step3.completed }" />
            </button>

            <div v-if="expandedStep === 'step3' && !steps.step3.completed" class="border-t px-4 pb-4 pt-4">
              <p class="mb-3 text-sm text-muted-foreground">启用自动备份，避免浏览器数据清理后丢失密钥。</p>
              <Button variant="secondary" class="w-full" @click="emit('navigate', 'settings')">去设置备份</Button>
            </div>
          </div>
        </CardContent>

        <CardFooter class="flex items-center justify-between">
          <Button variant="ghost" @click="handleSkip">跳过引导</Button>
          <Button :disabled="!steps.step1.completed" @click="handleStartUsing">开始使用</Button>
        </CardFooter>
      </Card>
    </div>
  </Teleport>
</template>
