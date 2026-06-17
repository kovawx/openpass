import { defineConfig } from 'wxt';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  vite: () => ({
    plugins: [UnoCSS()]
  }),
  manifest: {
    name: 'OpenPass',
    version: '0.2.1',
    description: '开源的 2FA 认证工具，本地存储密钥，一键生成验证码',
    homepage_url: 'https://github.com/kovawx/openpass',
    permissions: [
      'storage',
      'downloads',
      'activeTab',
      'tabs',
      'contextMenus',
      'notifications',
      'alarms'
    ],
    icons: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },
  modules: ['@wxt-dev/module-vue']
});
