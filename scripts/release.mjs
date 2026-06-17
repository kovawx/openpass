#!/usr/bin/env node
/**
 * OpenPass 一键发版脚本
 *
 * 流程：bump 版本号 → commit → tag → push 到所有远端
 * 同步更新：package.json / wxt.config.ts / README.md（当前版本）
 *
 * 用法：
 *   pnpm release <patch|minor|major|版本号> [选项]
 *
 * 示例：
 *   pnpm release patch            # 0.2.0 → 0.2.1
 *   pnpm release minor            # 0.2.0 → 0.3.0
 *   pnpm release 1.0.0            # 指定版本号
 *   pnpm release minor --beta     # develop 分支打 beta tag（vX.Y.Z-beta）
 *   pnpm release minor --dry-run  # 只看计划，不执行
 *   pnpm release minor --yes      # 跳过确认
 *
 * 约定：
 * - 需在干净的工作区运行（无未提交改动），避免把无关改动混入发版提交。
 * - 发版说明（changelog）由 GitHub Action 从 commit 自动生成于 Releases 页面，无需手动维护。
 * - 按 CONTRIBUTING.md：develop 分支用 vX.Y.Z-beta，main 分支用 vX.Y.Z。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root = resolve(import.meta.dirname, '..');

/** 静默执行，返回 stdout（trimmed）。 */
const quiet = (cmd) =>
  execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
/** 透传 stdio 执行，让用户看到 git 进度。 */
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipConfirm = args.includes('--yes');
const beta = args.includes('--beta');
const bumpArg = args.find((a) => !a.startsWith('-'));

function printUsage() {
  console.log(
    `OpenPass 发版脚本

用法: pnpm release <patch|minor|major|版本号> [选项]

选项:
  --beta      生成 beta tag（vX.Y.Z-beta），develop 分支测试用
  --dry-run   仅展示发版计划，不执行任何变更
  --yes       跳过确认提示

流程: 更新版本号 → 提交 → 打 tag → 推送所有远端
更新: package.json / wxt.config.ts / README.md
注意: 需干净工作区（发版说明由 GitHub Action 自动生成于 Releases 页面）`
  );
}

if (!bumpArg) {
  printUsage();
  process.exit(1);
}

function computeNext(current, kind) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    console.error(`✗ 无法解析当前版本号: ${current}`);
    process.exit(1);
  }
  const [, maj, min, pat] = match.map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  return kind;
}

const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next = computeNext(current, bumpArg);

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`✗ 无效版本号: ${next}`);
  process.exit(1);
}
if (next === current) {
  console.error(`✗ 新版本与当前版本相同: ${current}`);
  process.exit(1);
}

const tagName = beta ? `v${next}-beta` : `v${next}`;

let existingTags = [];
try {
  existingTags = quiet('git tag --list').split('\n').filter(Boolean);
} catch {
  /* ignore */
}
if (existingTags.includes(tagName)) {
  console.error(`✗ tag ${tagName} 已存在`);
  process.exit(1);
}

const branch = quiet('git rev-parse --abbrev-ref HEAD');
const remotes = quiet('git remote').split('\n').filter(Boolean);

console.log(`发版计划:
  当前版本 : ${current}
  目标版本 : ${next}
  分支     : ${branch}
  tag      : ${tagName}
  远端     : ${remotes.join(', ') || '(无)'}
  更新文件 : package.json, wxt.config.ts, README.md
`);

if (dryRun) {
  console.log('--dry-run：仅展示计划，未做任何变更。');
  process.exit(0);
}

const pending = quiet('git status --porcelain');
if (pending) {
  console.error(`✗ 工作区不干净，请先提交或暂存以下改动：\n${pending}`);
  process.exit(1);
}

async function main() {
  if (!skipConfirm) {
    const rl = readline.createInterface({ input, output });
    const answer = (
      await rl.question(`确认发布 ${tagName} 并推送到 ${remotes.length} 个远端？(y/N) `)
    ).toLowerCase();
    rl.close();
    if (answer !== 'y') {
      console.log('已取消。');
      process.exit(0);
    }
  }

  // 1) 更新版本号
  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const wxtPath = resolve(root, 'wxt.config.ts');
  writeFileSync(
    wxtPath,
    readFileSync(wxtPath, 'utf8').replace(
      /(version:\s*['"])(\d+\.\d+\.\d+)(['"])/,
      `$1${next}$3`
    )
  );

  const readmePath = resolve(root, 'README.md');
  writeFileSync(
    readmePath,
    readFileSync(readmePath, 'utf8').replace(/(当前版本：v)(\d+\.\d+\.\d+)/, `$1${next}`)
  );
  console.log('✓ 已更新 package.json / wxt.config.ts / README.md');

  // 2) 提交
  run('git add package.json wxt.config.ts README.md');
  run(`git commit -m "chore(release): ${tagName}"`);

  // 3) 打 tag
  run(`git tag ${tagName}`);
  console.log(`✓ 已提交并打 tag ${tagName}`);

  // 4) 推送所有远端（当前分支 + tag）
  for (const remote of remotes) {
    console.log(`→ 推送 ${remote} ...`);
    run(`git push ${remote} ${branch}`);
    run(`git push ${remote} ${tagName}`);
  }

  console.log(`\n✓ 完成：${tagName} 已推送到 ${remotes.length} 个远端。`);
  console.log('发版说明将由 GitHub Action 从 commit 自动生成于 Releases 页面，无需手动维护。');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
