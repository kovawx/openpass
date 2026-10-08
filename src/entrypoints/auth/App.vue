<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Eye, EyeOff } from 'lucide-vue-next';

const authStore = useAuthStore();

const password = ref('');
const showPassword = ref(false);
const error = ref('');
const submitting = ref(false);
const now = ref(Date.now());

const remainingAttempts = computed(() => authStore.getRemainingAttempts());
const isLocked = computed(() => authStore.isLocked());

const remainingLockTime = computed(() => {
  if (!isLocked.value || !authStore.authLockedUntil) return 0;
  return Math.max(0, authStore.authLockedUntil - now.value);
});

const remainingMinutes = computed(() => {
  return Math.floor(remainingLockTime.value / 60000);
});

const remainingSeconds = computed(() => {
  return Math.floor((remainingLockTime.value % 60000) / 1000);
});

let timer: number | null = null;

function startTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (isLocked.value) {
    timer = window.setInterval(() => {
      now.value = Date.now();
    }, 1000);
  }
}

watch(isLocked, () => {
  startTimer();
});

onMounted(async () => {
  await authStore.init();
  startTimer();
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});

async function handleSubmit() {
  if (!password.value) {
    error.value = '请输入主密码';
    return;
  }

  if (isLocked.value) {
    error.value = '尝试次数过多，请稍后再试';
    return;
  }

  submitting.value = true;
  error.value = '';

  try {
    const isValid = await authStore.login(password.value);

    if (isValid) {
      password.value = '';
      const urlParams = new URLSearchParams(window.location.search);
      const redirect = urlParams.get('redirect') || 'options.html';
      window.location.href = chrome.runtime.getURL(redirect === 'popup.html' ? 'popup.html' : 'options.html');
    } else {
      if (isLocked.value) {
        error.value = '尝试次数过多，请稍后再试';
        submitting.value = false;
        return;
      }
      error.value = '主密码错误';
      password.value = '';
    }
  } catch (err) {
    error.value = '验证失败，请重试';
    console.error('验证失败:', err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
    <Card class="w-full max-w-md">
      <CardHeader class="text-center">
        <div class="mx-auto w-14 h-14 mb-4 bg-primary/10 rounded-full flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-7 h-7 text-primary">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <CardTitle class="text-xl">验证主密码</CardTitle>
        <CardDescription>请输入主密码以访问你的密钥</CardDescription>
      </CardHeader>

      <CardContent>
        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div class="space-y-2">
            <Label for="password">主密码</Label>
            <div class="relative">
              <Input
                id="password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                placeholder="输入主密码"
                autocomplete="current-password"
                autofocus
                :disabled="submitting || isLocked"
                class="pr-10"
              />
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                :disabled="submitting || isLocked"
                @click="showPassword = !showPassword"
              >
                <Eye v-if="!showPassword" class="h-5 w-5" />
                <EyeOff v-else class="h-5 w-5" />
              </button>
            </div>
          </div>

           <p v-if="error" class="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
             {{ error }}
           </p>

           <div v-if="isLocked" class="text-sm text-center text-destructive bg-destructive/10 px-3 py-3 rounded-md space-y-1">
             <p>尝试次数过多，已临时锁定</p>
             <p class="font-medium">
               剩余等待时间：{{ remainingMinutes }}分 {{ remainingSeconds }}秒
             </p>
           </div>

           <Button
             type="submit"
             class="w-full"
             :disabled="submitting || isLocked"
           >
             {{ submitting ? '验证中...' : (isLocked ? '已锁定' : '解锁') }}
           </Button>

           <p v-if="!isLocked && remainingAttempts < 5" class="text-sm text-center text-muted-foreground">
             剩余尝试次数：<span class="font-medium text-destructive">{{ remainingAttempts }}</span>
           </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>