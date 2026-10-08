<script setup lang="ts">
import type { OtpSettings } from '@/utils/otp';
const props = defineProps<{ settings: OtpSettings }>();
const emit = defineEmits<{ update: [settings: OtpSettings] }>();
function update(key: keyof OtpSettings, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit('update', { ...props.settings, [key]: ['digits', 'period', 'counter'].includes(key) ? Number(value) : value });
}
</script>

<template>
  <div class="grid grid-cols-2 gap-3">
    <label class="form-group">类型
      <select :value="settings.type || 'totp'" class="input" @change="update('type', $event)">
        <option value="totp">TOTP（按时间）</option><option value="hotp">HOTP（按次数）</option>
      </select>
    </label>
    <label class="form-group">算法
      <select :value="settings.algorithm || 'SHA1'" class="input" @change="update('algorithm', $event)">
        <option value="SHA1">SHA1</option><option value="SHA256">SHA256</option><option value="SHA512">SHA512</option>
      </select>
    </label>
    <label class="form-group">验证码位数
      <select :value="settings.digits || 6" class="input" @change="update('digits', $event)">
        <option :value="6">6 位</option><option :value="8">8 位</option>
      </select>
    </label>
    <label v-if="settings.type === 'hotp'" class="form-group">下次使用的计数器
      <input :value="settings.counter ?? 0" class="input" type="number" min="0" step="1" @input="update('counter', $event)">
    </label>
    <label v-else class="form-group">更新周期（秒）
      <input :value="settings.period || 30" class="input" type="number" min="1" max="3600" step="1" @input="update('period', $event)">
    </label>
  </div>
</template>
