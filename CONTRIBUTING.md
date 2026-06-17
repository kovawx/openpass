# 贡献指南

感谢你考虑为 OpenPass 做出贡献！

## 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [分支管理](#分支管理)
- [开发指南](#开发指南)
- [提交规范](#提交规范)
- [代码规范](#代码规范)
- [发布流程](#发布流程)

## 行为准则

本项目采用贡献者公约作为行为准则。参与此项目即表示你同意遵守其条款。请阅读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 了解详情。

## 如何贡献

### 报告 Bug

如果你发现了 Bug，请通过 [Issues](https://github.com/kovawx/openpass/issues) 提交报告。

提交 Bug 报告前，请：

1. 搜索现有 Issues，确认该问题尚未被报告
2. 使用 Bug 报告模板填写详细信息
3. 提供复现步骤和环境信息

### 提出新功能

如果你有新功能建议，欢迎通过 [Issues](https://github.com/kovawx/openpass/issues) 提交。

提交功能请求时，请：

1. 清晰描述功能及其使用场景
2. 说明该功能解决的问题
3. 如果可能，提供实现建议

### 提交代码

1. Fork 本仓库
2. 从 `develop` 分支创建功能分支
3. 提交变更（遵循 [提交规范](#提交规范)）
4. 推送到你的分支
5. 创建 Pull Request 到 **`develop` 分支**

## 分支管理

### 分支结构

```
main                 # 稳定发布分支（只读，仅通过 PR 合并）
└── develop          # 开发集成分支（默认 PR 目标）
    ├── feature/xxx  # 新功能分支
    └── fix/xxx      # Bug 修复分支
```

### 分支说明

| 分支 | 说明 | 命名规范 |
|------|------|---------|
| `main` | 稳定发布分支，只读 | - |
| `develop` | 开发集成分支，所有 PR 先合并到这里 | - |
| `feature/功能描述` | 新功能开发分支 | `feature/dark-theme` |
| `fix/问题描述` | Bug 修复分支 | `fix/backup-import-error` |

### PR 流程

```
feature/fix 分支  →  PR 到 develop  →  测试  →  PR 到 main  →  发布
```

1. 所有 PR 目标分支是 `develop`，不是 `main`
2. develop 测试稳定后，统一 PR 到 main 发布
3. PR 合并到 develop 后，可以打 `-beta` tag 进行测试验证

## 开发指南

### 环境准备

1. 克隆仓库
   ```bash
   git clone https://github.com/kovawx/openpass.git
   cd openpass
   ```

2. 安装依赖
   ```bash
   pnpm install
   ```

3. 开发模式
   ```bash
   pnpm dev
   ```

4. 在 Chrome 中加载扩展
   - 打开 `chrome://extensions/`
   - 开启「开发者模式」
   - 点击「加载已解压的扩展程序」
   - 选择项目下的 `.output/chrome-mv3` 目录

### 项目结构

```
openpass/
├── .github/                    # GitHub 配置
│   ├── ISSUE_TEMPLATE/         # Issue 模板
│   └── workflows/              # GitHub Actions
├── src/
│   ├── components/             # Vue 组件
│   │   ├── manager/            # 管理页面组件
│   │   └── ui/                 # UI 基础组件
│   ├── composables/            # Vue composables
│   ├── entrypoints/            # 扩展入口
│   │   ├── background.ts       # Service Worker
│   │   ├── content/            # 内容脚本
│   │   ├── popup/              # 弹窗页面
│   │   └── options/            # 管理后台页面
│   ├── stores/                 # Pinia 状态管理
│   └── utils/                  # 工具函数
├── public/                     # 静态资源
│   └── icons/                  # 扩展图标
├── wxt.config.ts               # WXT 配置
├── uno.config.ts               # UnoCSS 配置
└── package.json
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发模式，自动热重载 |
| `pnpm build` | 生产构建，输出到 `.output/` |
| `pnpm lint` | 代码检查 |

### 测试

目前项目没有自动化测试，请手动测试以下场景：

- [ ] 添加新密钥
- [ ] 编辑现有密钥
- [ ] 删除密钥
- [ ] 验证码生成正确性
- [ ] 验证码倒计时
- [ ] 搜索功能
- [ ] 导出/导入备份
- [ ] 自动备份功能
- [ ] 右键菜单解析 QR 码
- [ ] 主密码保护功能

## 提交规范

本项目采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

### 提交格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 类型 (type)

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 代码重构 |
| `perf` | 性能优化 |
| `test` | 添加测试 |
| `chore` | 构建/工具变更 |

### 范围 (scope)

可选，表示影响范围：

- `popup` - 弹窗相关
- `manager` - 管理页面相关
- `content` - 内容脚本相关
- `background` - Service Worker 相关
- `backup` - 备份相关
- `crypto` - 加密相关
- `ci` - CI/CD 相关

### 示例

```
feat(popup): 添加暗色主题支持
fix(backup): 修复导入备份后无法自动备份的问题
docs: 更新安装说明和分支管理流程
chore(ci): 添加自动发布工作流
```

## 代码规范

### TypeScript / Vue

- 使用 2 空格缩进
- 使用单引号
- 函数和变量使用驼峰命名
- 组件使用帕斯卡命名
- 添加必要的 JSDoc 注释
- 优先使用 TypeScript 类型声明

### CSS / UnoCSS

- 使用 UnoCSS 原子化 CSS
- 必要时使用语义化类名
- 避免使用 `!important`

## 发布流程

本项目使用 GitHub Actions 自动构建发布。

### 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- `MAJOR.MINOR.PATCH`
- 例如：`1.0.0` → `1.0.1`（修复）→ `1.1.0`（新功能）→ `2.0.0`（重大变更）

### Tag 类型

| Tag 格式 | 说明 | 分支 |
|----------|------|------|
| `v0.x.y-beta` | 测试版，用于内部验证 | `develop` |
| `v0.x.y` | 正式发布版 | `main` |

### 发布步骤

1. **PR 合并到 develop** - 所有功能和修复 PR 合并到 develop 分支
2. **测试验证** - 在 develop 上打 `-beta` tag，CI 自动构建测试包
3. **测试通过** - 确认功能正常，无回归问题
4. **PR 到 main** - 提交从 develop 到 main 的 PR
5. **发布正式版** - 在 main 上打正式 tag，CI 自动构建发布

---

再次感谢你的贡献！