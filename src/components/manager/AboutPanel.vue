<script setup lang="ts">
import { ref, onMounted } from 'vue';

const version = ref('');
const buildTime = ref('');

onMounted(() => {
  const manifest = chrome.runtime.getManifest();
  version.value = manifest.version;
  buildTime.value = new Date().toLocaleDateString('zh-CN');
});
</script>

<template>
  <div class="space-y-6">
    <header class="page-header">
      <h1 class="text-2xl font-bold text-gray-900">关于</h1>
    </header>

    <!-- 应用信息卡片 -->
    <div class="bg-white rounded-lg shadow p-8 text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-primary-100 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>

      <h2 class="text-2xl font-bold text-gray-900">OpenPass</h2>
      <p class="text-gray-500 mt-1">v{{ version }}</p>
      <p class="text-sm text-gray-600 mt-3">简洁、本地、安全的两步验证管理器</p>

      <!-- 链接 -->
      <div class="flex justify-center space-x-6 mt-6">
        <a
          href="https://github.com/kovawx/openpass"
          target="_blank"
          class="inline-flex items-center text-sm text-primary-600 hover:text-primary-700"
        >
          <svg class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          GitHub
        </a>
        <a
          href="https://github.com/kovawx/openpass/issues"
          target="_blank"
          class="inline-flex items-center text-sm text-primary-600 hover:text-primary-700"
        >
          <svg class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          问题反馈
        </a>
        <a
          href="https://github.com/kovawx/openpass/blob/main/PRIVACY.md"
          target="_blank"
          class="inline-flex items-center text-sm text-primary-600 hover:text-primary-700"
        >
          <svg class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          隐私政策
        </a>
      </div>
    </div>

    <!-- 版本信息 -->
    <div class="bg-white rounded-lg shadow p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">版本信息</h3>

      <div class="space-y-3">
        <div class="flex justify-between text-sm">
          <span class="text-gray-600">版本号</span>
          <span class="text-gray-900 font-medium">v{{ version }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-600">构建时间</span>
          <span class="text-gray-900">{{ buildTime }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-600">作者</span>
          <span class="text-gray-900">kovawx</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-600">协议</span>
          <span class="text-gray-900">MIT License</span>
        </div>
      </div>
    </div>

    <!-- 功能特性 -->
    <div class="bg-white rounded-lg shadow p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">功能特性</h3>

      <div class="grid grid-cols-2 gap-4">
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">TOTP 验证码生成</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">QR 码扫描识别</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">主密码加密保护</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">自动定时备份</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">备份加密导出</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">键盘快捷键</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">搜索过滤</span>
        </div>
        <div class="flex items-start space-x-2">
          <svg class="w-5 h-5 text-green-500 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="text-sm text-gray-700">本地数据存储</span>
        </div>
      </div>
    </div>

    <!-- 安全说明 -->
    <div class="bg-blue-50 border border-blue-200 rounded-lg p-6">
      <h3 class="text-lg font-semibold text-blue-900 mb-3">安全说明</h3>
      <ul class="space-y-2 text-sm text-blue-800">
        <li>• 所有密钥数据仅存储在浏览器本地，不上传任何服务器</li>
        <li>• 主密码使用 PBKDF2 算法哈希存储，无法逆向破解</li>
        <li>• 密钥数据使用 AES-GCM 算法加密，需要主密码解锁</li>
        <li>• 备份文件可选择加密，防止数据泄露</li>
        <li>• 会话超时自动锁定，保护隐私安全</li>
      </ul>
    </div>
  </div>
</template>