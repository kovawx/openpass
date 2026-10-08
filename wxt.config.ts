import { defineConfig } from 'wxt';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  imports: {
    dirsScanOptions: {
      // 默认导出会按文件名注册为 crypto，不能遮蔽浏览器 Web Crypto API。
      fileFilter: (file) => !file.replaceAll('\\', '/').endsWith('/utils/crypto.ts')
    }
  },
  vite: () => ({
    plugins: [UnoCSS()]
  }),
  manifest: {
    name: 'OpenPass',
    version: '0.3.0',
    description: '开源的 2FA 认证工具，本地存储密钥，一键生成验证码',
    homepage_url: 'https://github.com/kovawx/openpass',
    permissions: [
      'storage',
      'activeTab',
      'tabs',
      'contextMenus',
      'notifications',
      'alarms'
    ],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    icons: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },
  modules: ['@wxt-dev/module-vue']
});
