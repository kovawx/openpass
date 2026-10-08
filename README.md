# OpenPass

> 开源、本地、安全的两步验证管理器

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=google-chrome&logoColor=white)](https://chromewebstore.google.com/detail/ejokhmkfamhdcopmfockefjfgdiginpp?utm_source=item-share-cb)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 简介

OpenPass 是一款 Chrome 浏览器扩展，支持 TOTP/HOTP 验证码管理。默认使用本地加密存储；可由用户主动启用自己的 S3/OSS 密文备份与多设备同步。下述能力描述对应当前开发分支。

**核心特性：**

- 🔐 **本地存储** - 密钥在浏览器本地加密保存，云端同步默认关闭
- 🔍 **智能匹配** - 自动识别当前网站，一键获取验证码
- 📋 **一键复制** - 点击验证码即可复制
- 💾 **自动备份** - 数据变化时自动备份，支持加密导出
- 🔒 **管理保护与日常免密** - 匹配、查看、复制和填充验证码免密；管理、导出和设置仍需主密码
- 🔢 **OTP 参数** - SHA1/SHA256/SHA512、6/8 位、可配置 TOTP 周期与 HOTP 计数器
- ↩️ **版本恢复** - 本地快照和云端历史支持合并或替换；云端冲突可比较后处理
- 🖥️ **管理后台** - 完整的密钥管理界面

## 快速开始

### 安装

1. 前往 [Chrome 网上应用店](https://chromewebstore.google.com)搜索 ["OpenPass"](https://chromewebstore.google.com/search/OpenPass) 安装
2. 或前往 [Releases](https://github.com/kovawx/openpass/releases) 下载最新版本手动安装

**手动安装步骤：**
1. 下载 zip 包并解压到本地目录
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压目录

### 基本使用

1. **添加密钥** - 点击扩展图标 → 点击 **+** 按钮 → 输入密钥和站点信息
2. **获取验证码** - 访问已保存站点，扩展图标显示匹配数量，点击即可复制
3. **备份密钥** - 点击右上角 **⋮** → 打开管理后台 → 备份恢复

## 文档

- [功能特性](docs/features.md) - 详细功能说明
- [安全说明](docs/security.md) - 数据安全与最佳实践
- [备份与恢复](docs/backup.md) - 备份策略与操作指南
- [常见问题](docs/faq.md) - 使用问题解答
- [隐私政策](PRIVACY.md) - 用户数据处理说明

## 开发

```bash
# 克隆仓库
git clone git@github.com:kovawx/openpass.git
cd openpass

# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建生产版本
pnpm build
```

## 致谢

灵感来源于 [LastPass](https://www.lastpass.com/)，感谢其为密码管理领域做出的贡献。

## License

[MIT License](LICENSE)

---

<p align="center">
  如果这个项目对你有帮助，欢迎 ⭐ Star 支持
</p>
