# AI 编程技能安装指南（Rust + 前端）

> 目的：让任何 AI agent 在**新项目**里按本文快速复现本次安装。
> 实测环境：Linux x64, node v22, npx 10.x, codex-cli 0.167.0, agy (Antigravity CLI), Claude Code。2026-11-17 全部命令与结论均运行时验证过。
> 技能来源与选型依据见文末「参考」。

## 1. 目标布局（安装后应长这样）

```
project/
├── .agents/skills/<skill-name>/SKILL.md   # canonical 位置（agy / omp 原生读取；git 可跟踪）
├── .claude/skills/<skill-name> -> ../../.agents/skills/<skill-name>   # Claude Code 链接
└── skills-lock.json                        # 来源/commit/hash 记录，可提交，可还原
```

各 CLI 的技能发现路径（**实测结论，与官方文档可能不一致**）：

| CLI | 读哪里 | 说明 |
|---|---|---|
| agy (Antigravity) | `<workspace>/.agents/skills/<name>/` 原生扫描 | 另有自有插件注册表 `agy plugin list`；还读 `AGENTS.md`、`.agents/rules/*.md` |
| Claude Code | 项目 `.claude/skills/`（符号链接）+ 全局 `~/.agents/skills/` | skills CLI 自动建链接 |
| Codex 0.167 | **仅全局 `~/.agents/skills`**，不扫仓库 | 二进制帮助文本说的 `$CODEX_HOME/skills` 是过时的；skills CLI 的 JSON 输出写 `"agents":["Codex"]` 只表示它认为已覆盖，不代表 Codex 能看到项目目录 |
| omp | `.agents/skills`（canonical） | |

推论：**项目级安装覆盖 agy / Claude / omp；Codex 需要额外做一次全局安装**（内容相同，链接到 `~/.agents/skills`）。

## 2. 前置检查

```bash
node --version && npx --version   # 需要 node >= 18
which agy codex claude 2>/dev/null # 哪些 CLI 在用，决定第 4 步做不做
```

## 3. 项目级安装（在项目根目录执行，串行一条条跑）

```bash
# 3.1 BeautifulRust —— 3 个技能：rust-best-practices / rust-port / rust-review
npx -y skills add morganlinton/BeautifulRust -a codex -a claude-code -y --json

# 3.2 Vercel 前端 —— vercel-react-best-practices + web-design-guidelines
#     注意：-s 必须重复写，逗号分隔会被当成一个技能名而 skip
npx -y skills add vercel-labs/agent-skills \
  -s vercel-react-best-practices -s web-design-guidelines \
  -a codex -a claude-code -y --json

# 3.3 Modern Web Guidance（GoogleChrome）—— modern-web-guidance + chrome-extensions
npx -y skills add GoogleChrome/modern-web-guidance -a codex -a claude-code -y --json

# 3.4 full-stack rust-skills —— 29 个 rust-* 技能（见 3.5 警告）
npx -y skills add full-stack-skills/rust-skills --skill '*' -a codex -a claude-code -y --json
```

每条命令输出 JSON，检查每项 `"status": "installed"` 且 `"path"` 指向 `<项目>/.agents/skills/...`。

### 3.5 ⚠️ 最大的坑：openspec 覆盖

`full-stack-skills/rust-skills` 仓库**捆绑了自己版本的 openspec skills**。若项目 `.agents/skills/openspec-*/` 是团队自己的（git 已跟踪），`--skill '*'` 会**直接覆盖这些文件**（本次实测 diff ±300 行）。

项目里已有 openspec skills 时，装完立刻检查并恢复：

```bash
git status --porcelain -- .agents/skills/ | grep '^ M'
git checkout -- '.agents/skills/openspec-*'          # 还原团队版本
jq 'del(.skills["openspec-apply-change"],
        .skills["openspec-archive-change"],
        .skills["openspec-explore"],
        .skills["openspec-propose"],
        .skills["openspec-sync-specs"],
        .skills["openspec-update-change"])' skills-lock.json > tmp && mv tmp skills-lock.json
```

并把这 6 个 openspec 名字从后续的 `--skill '*'` 场景中排除（lockfile 里不应有它们）。新项目没有 openspec 则无需处理。

**全局 `-g` 重跑同样会踩这个坑**：若全局 `~/.agents/skills/openspec-*/` 已存在（openspec CLI 装的），`npx skills add full-stack-skills/rust-skills --skill '*' -g` 会把它们也换成 rust-skills 旧版副本（实测发生并已修复）。全局目录没有 git 保护，恢复方法是从项目团队版拷回：

```bash
for s in openspec-apply-change openspec-archive-change openspec-explore openspec-propose; do
  cp .agents/skills/$s/SKILL.md ~/.agents/skills/$s/SKILL.md
done
```

规避：rust-skills 的全局/项目刷新**不要用 `--skill '*'`**，改为点名要更新的技能（`-s rust-web -s rust-concurrency ...`），或先 `rm` 掉 openspec 条目再跑。

## 4. 全局安装（只为让 Codex 看得到；agy/Claude/omp 不需要这步）

```bash
# 在任意目录执行（-g 装到 ~/.agents/skills 并纳管）
npx -y skills add morganlinton/BeautifulRust -g -a codex -y --json
# ⚠️ rust-skills 全量安装必须走「备份 → 安装 → 还原」：--skill '*' 会把全局
#    ~/.agents/skills/openspec-* 覆盖成 rust-skills 旧版副本（实测踩坑两次，见 3.5）
mkdir -p /tmp/openspec-backup
for s in openspec-apply-change openspec-archive-change openspec-explore openspec-propose; do
  [ -f ~/.agents/skills/$s/SKILL.md ] && cp ~/.agents/skills/$s/SKILL.md /tmp/openspec-backup/
done
npx -y skills add full-stack-skills/rust-skills --skill '*' -g -a codex -y --json
for s in openspec-apply-change openspec-archive-change openspec-explore openspec-propose; do
  [ -f /tmp/openspec-backup/$s/SKILL.md ] && cp /tmp/openspec-backup/$s/SKILL.md ~/.agents/skills/$s/SKILL.md
done
npx -y skills add vercel-labs/agent-skills \
  -s vercel-react-best-practices -s web-design-guidelines -g -a codex -y --json
npx -y skills add GoogleChrome/modern-web-guidance -s modern-web-guidance -g -a codex -y --json
```

已全局装过同源技能时会幂等（不会重复内容）。不要在项目 `.codex/` 下建任何东西——Codex 不读它。

## 5. 运行时验证（必须做，目录存在 ≠ CLI 真的看到）

各 CLI 真跑一条最小 prompt，让它列出技能名：

```bash
cd <项目根>

# Codex：输出应包含 rust-web / vercel-react-best-practices / modern-web-guidance 等
timeout 120 codex exec --skip-git-repo-check \
  "List the names of your available skills, one per line, nothing else." 2>&1 | tail -40

# agy：-p 后直接跟提示词；--print-timeout 必须带单位；显式指定模型 id 避免无头模式解析失败
timeout 100 agy -p "List the names of your available skills, one per line, nothing else." \
  --model gemini-4-hydrogen --print-timeout 90s 2>&1 | tail -25

# Claude Code
timeout 90 claude -p "List the names of your available skills, one per line, nothing else." 2>&1 | head -40
```

判定：rust-* 全集 + 两个 Vercel 技能 + modern-web-guidance 出现即通过。注意项目里装的同名 rust-* 与全局是同内容副本，Codex 列表来自全局——这是预期行为。

## 6. 日常管理

```bash
npx skills ls                                  # 列出已装（项目+全局）
npx skills update                              # 按来源更新项目技能
npx skills update -g                           # 更新全局
npx skills experimental_install                # 按 skills-lock.json 原样恢复（新机器/新 clone）
npx skills remove <name>                       # 卸载
agy plugin list                                # agy 自有插件（modern-web-guidance 可能已内置）

# openspec 完整性检查（全局 vs 项目团队版；任何全局批量安装/更新后跑一次，无输出 = 一致）
for s in openspec-apply-change openspec-archive-change openspec-explore openspec-propose; do
  diff -q ~/.agents/skills/$s/SKILL.md .agents/skills/$s/SKILL.md
done
```

## 7. 执行注意事项（本次踩过的）

1. **串行执行**所有 `npx skills add`。并行跑会落到 shell 副本里，提示 "changes here won't persist"，且无法确认落盘；装完用 `ls .agents/skills/` 再核一遍。
2. `-s a,b` 逗号语法无效（被当成一个名字，status 变 `skipped`），必须重复 `-s`。
3. Codex 版本相关：0.167.0 实测仅全局；未来版本可能支持仓库级，装完用第 5 步验证，别信文档。
4. `skills-lock.json` 提交进 git；`.claude/skills/` 是相对符号链接也可提交，队友 clone 后 Claude Code 直接可用。
5. Microsoft Pragmatic Rust Guidelines 是纯网页设计参考（microsoft.github.io/rust-guidelines），**不是可安装技能**。要落地就摘要进 `.agents/rules/*.md`（agy 原生读）或 AGENTS.md，不要去找它的技能仓库。
6. 真正的质量门禁在 CI：rustfmt + clippy + cargo test；技能只约束 agent 行为。

## 8. 本项目基线快照（2026-11-17，供漂移对比）

安装时的 commit 钉扎（见 `skills-lock.json`）：

| 来源 | 钉扎 commit |
|---|---|
| `full-stack-skills/rust-skills` | `b8a6af7`（v3.9，rust-stable 基于 Rust 1.97.1） |
| `morganlinton/BeautifulRust` | `b9718436` |
| `vercel-labs/agent-skills` | `1a2c79d`（vercel-react-best-practices + web-design-guidelines） |
| `GoogleChrome/modern-web-guidance` | `64a6d70`（modern-web-guidance + chrome-extensions） |

项目 `.agents/skills/` = 36 个来源技能 + 6 个团队 openspec（git 跟踪，不属于 lockfile）；`.claude/skills/` 40 条符号链接；三个 CLI（codex / agy / claude）当日运行时验证通过。

检查上游是否有新版：

```bash
git ls-remote https://github.com/full-stack-skills/rust-skills HEAD        # 对比 b8a6af7...
git ls-remote https://github.com/morganlinton/BeautifulRust HEAD           # 对比 b9718436...
git ls-remote https://github.com/vercel-labs/agent-skills HEAD             # 对比 1a2c79d...
git ls-remote https://github.com/GoogleChrome/modern-web-guidance HEAD     # 对比 64a6d70...
```

rust-skills 29 技能点名清单（刷新/补装时用 `-s <name>` 逐个点名，不要 `--skill '*'`，原因见 3.5）：

- **Core**：rust-stable、rust-stdlib、rust-by-example
- **Design**：rust-api-design、rust-crate-discovery
- **Engineering**：rust-workspace、rust-module-layout、rust-cargo-build、rust-dependencies、rust-semver、rust-documentation、rust-java-migration、rust-java-migration-testing
- **Domain**：rust-concurrency、rust-testing、rust-performance、rust-observability、rust-unsafe-ffi、rust-uniffi-building、rust-macros、rust-lombok-macros、rust-cli、rust-web、rust-http-client、rust-database、rust-web-security、rust-embedded
- **Quality**：rust-code-review、rust-style-clippy

## 参考

| 技能集 | 来源仓库 | 内容 |
|---|---|---|
| BeautifulRust | `morganlinton/BeautifulRust` | rust-best-practices / rust-review / rust-port，针对 AI 常见错误（滥用 clone、unwrap、Box<dyn Trait>、unsafe） |
| Rust Skills | `full-stack-skills/rust-skills`（Apache-2.0，v3.9） | 29 技能五层架构：Core（语言语义/stdlib/代码模式）、Design（Rust API Guidelines ~100 条 C-* 规则、crate 四源加权选型）、Engineering（workspace/模块布局/Cargo/依赖治理/semver/rustdoc/Java→Rust 迁移）、Domain（并发/测试/性能/可观测/unsafe-FFI/UniFFI 多语言绑定/宏/CLI/web/HTTP 客户端/数据库/web 安全/嵌入式）、Quality（code-review/clippy）。SKILL.md 含触发元数据、任务路由、工作流、验证门禁、可编译示例；仓库自带 `scripts/validate_skills.py` 质量门禁。注意：它捆绑的 openspec 副本是旧版，见 3.5 |
| Vercel React Best Practices | `vercel-labs/agent-skills` | React/Next.js 40+ 条性能与工程规则（部分 Next.js 专属，纯 Vite 项目不要照搬） |
| Web Interface Guidelines | `vercel-labs/agent-skills` | UI/UX 质量规范：交互反馈、焦点、表单错误位置、Loading/Empty/Error 状态 |
| Modern Web Guidance 1.0 | `GoogleChrome/modern-web-guidance` | ~250 项现代 Web 特性 + 203 场景，Chrome/Edge/Firefox/MDN 共同维护 |
| Microsoft Pragmatic Rust Guidelines | https://microsoft.github.io/rust-guidelines/ | 设计参考（API/Error/Async/Memory/Unsafe/AI Guidelines），网页版 |
