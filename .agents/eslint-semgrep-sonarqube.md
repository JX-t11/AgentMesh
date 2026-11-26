# 代码质量、依赖与镜像安全检查:ESLint · Semgrep · Mira · Qualor · Trivy · Dependabot

ESLint、Semgrep、Mira、Trivy 在本地运行;Qualor 质量门在本机共享实例上跑;Dependabot 和 CI 在 GitHub 上运行。共享 SonarQube 实例已于 2026-11-25 退役(见[第八节](#八sonarqube-退役记录2026-11-25)),其看板与质量门职能由 Qualor 接管。配置方法沿用 [software-factory 同名文档](../../software-factory/.agents/eslint-semgrep-sonarqube.md),按本仓库结构(Rust 服务端、`web/` 与 `docs-site/` 两个 npm 工程、两个 Agent 插件)适配。

| 工具 | 角色 | 运行方式 | 范围 |
|---|---|---|---|
| ESLint + typescript-eslint | 本地提交门禁与类型审计 | npm scripts,编辑器实时 | `web/` 的 JS、TS 和 TSX |
| Semgrep | 安全模式审计(OWASP/CI/密钥) | docker 一次性容器 | 仓库根全部代码(含 shell、YAML、Dockerfile、Rust) |
| Mira | AI 代码审查(非质量门,供人工复核) | docker 一次性容器 | 已提交分支 diff(`git diff base...HEAD`) |
| Qualor | 质量门:合并前新增问题判定 | 本机共享实例 + 一次性扫描容器 | JS/TS 已提交快照(web、双插件、docs-site、scripts) |
| Trivy | 依赖与镜像漏洞、SBOM | docker 一次性容器 | npm 锁文件、本机 AgentMesh 镜像 |
| Dependabot | 依赖版本更新 PR | GitHub 默认分支配置 | Cargo、`web/`、`docs-site/`、GitHub Actions |
| GitHub Actions | 提交门禁 | PR 与 `main` 推送 | Rust、前端、文档、覆盖率产物、Trivy 依赖扫描 |

Rust 的确定性门禁仍是 `cargo fmt`、`clippy -D warnings` 和 `cargo test`(CI 与本地),Qualor/Semgrep/Mira 都不替代它。

---

## 一、ESLint + typescript-eslint

### 安装(已完成,重装环境时执行)

```bash
cd web
npm install          # devDeps 已写入 web/package.json:eslint ^10.15.0、@eslint/js ^10.0.1、typescript-eslint ^8.73.0、globals ^17.14.0
npx eslint --version # 应输出 10.x
```

本地使用 Node.js 22.23(锁定的 ESLint 10 要求 Node.js `^20.19.0 || ^22.13.0 || >=24`)。`@eslint/js` 与 `eslint` 版本线独立,当前对应 `10.0.1`。

### 配置文件(两份,都在 `web/`)

**`eslint.config.mjs` —— 门禁档**(`npm run lint` 用)
- 两档共享排除规则:忽略 `node_modules`、`dist`、`coverage`。
- `*.mjs/*.js/*.cjs`(`scripts/package-connectors.mjs`、`public/` 下脚本)→ `js.configs.recommended`,globals 用 **node + browser 双上下文**
- `*.ts/*.tsx` → `tseslint.configs.recommended`
- `no-unused-vars` 配置 `^_` 忽略模式 + `ignoreRestSiblings`(与 software-factory 同一口径)

**`eslint.config.typed.mjs` —— typed 审计档**(`npm run lint:typed` 用)
- 在门禁档基础上,对 `web/src/**/*.{ts,tsx}` 与 `vite.config.ts` 开 `recommendedTypeChecked`
- `projectService: true` 关联 `web/tsconfig.json`(`strict` + `noUnusedLocals` + `noUnusedParameters` 已在 tsconfig)
- typed 规则能抓 tsc 抓不到的问题:`no-floating-promises`、`no-misused-promises`、`no-base-to-string` 等

### 命令(在 `web/` 下)

```bash
npm run lint            # 平台代码门禁
npm run lint:fix        # 自动修复可安全修复项
npm run lint:typed      # 类型审计
npx eslint <file>       # 单文件检查
```

### VS Code 实时检查

安装官方 **ESLint** 扩展(`dbaeumer.vscode-eslint`)。根目录 `.vscode/settings.json` 已配置:

```json
{ "eslint.workingDirectories": ["web"] }
```

保存即出红线/黄线,悬停看规则说明,Quick Fix 一键修复。

### 当前基线(2026-11-26 复测)

`npm run lint` 与 `npm run lint:typed` 均退出码 `0`,0 errors / 0 warnings。首轮清理记录(2026-11-23):typed 初测 80 项,58 项 `--fix` 自动清除,手工修复 22 项后归零,分布见[验证记录](#九验证记录)。

### 维护口径

提交 `web/` 代码前运行 `npm run lint`,以退出码 `0` 为通过条件;定期(改动面大或 PR 前)运行 `npm run lint:typed`,同一口径核对新增命中。

---

## 二、Semgrep

### 安装

不需要本机安装 CLI:`scripts/semgrep-scan.sh` 用 **docker 一次性容器**(`--rm`,镜像只在首次 pull,之后走本地缓存;源码 `:ro` 挂载,退出即清理,扫描器物理上改不了仓库)。

### 共享规则缓存与登录态

规则集首次运行从 semgrep registry 联网拉取,缓存与登录态都指向跨项目共享目录:

```
/home/jx03/work_lumin/llm_train/code-workplace/dev-tools/semgrep/home
```

脚本把容器 `HOME` 挂到这里。2026-11-26 起目录属主已修正为当前用户,缓存正常生效,不再回退临时缓存。`semgrep login` 的 token 落在同目录 `.semgrep/settings.yml`(headless 授权流程见 software-factory 文档),登录后 Registry 规则集解锁 Pro 规则层:默认规则集(`p/owasp-top-ten p/ci p/secrets`)一次扫描运行的规则数从 295 涨到约 1500。目录不可写时脚本仍按设计回退临时缓存并输出 `WARN`。

### 用法(仓库根目录)

```bash
bash scripts/semgrep-scan.sh                            # 默认 p/owasp-top-ten + p/ci + p/secrets
bash scripts/semgrep-scan.sh p/javascript               # 指定单个规则集
bash scripts/semgrep-scan.sh p/owasp-top-ten p/rust     # 指定多组规则
```

每个位置参数对应一个规则配置。传入含空格的路径时,用引号包住整个路径。

已排除:`.git`、`.agents`(agent 规则文档与已安装技能指南,纯 markdown,非产品代码;同 software-factory 排除 vendored `.claude/reference` 的口径)、`target`(Rust 构建产物)、`node_modules`、`dist`、`coverage`。

### 命中定性口径

默认命中只供审计,脚本返回非零时检查失败;合并前门禁要求定性后复扫至 0 阻断(修复、存量说明或误报归档)。误报按「规则 + 位置」归档:改产品代码,或对 vendored/文档类内容加排除项,并在[验证记录](#九验证记录)留定性结论。

Semgrep 对本仓库 Rust 的实际覆盖(2026-11-26 构造样例实测):**密钥/凭据泄露可靠命中**(generic secrets 在 `.rs` 上生效,格式正确的 AWS key 命中、官方示例值按设计 allowlist);语言级 Rust 规则 49 条(Pro 层,登录态解锁),但命令注入、弱哈希类深度规则对常见写法未命中,覆盖面有限——Rust 语义层安全仍靠 clippy + `cargo test`。shell/YAML 安全由默认规则集中的 `p/ci` 承担。

---

## 三、Mira(AI 代码审查 CLI)

### 现状

- 入口为 `../dev-tools/mira/review.sh`,从目标仓库根运行,使用按摘要固定的 Mira `0.11.1` 镜像。CLI 可独立于 Mira 服务与平台凭据运行。[Mira 源码](https://github.com/miracodeai/mira)
- CLI 使用智谱 GLM Coding Plan 的 OpenAI 兼容端点与模型 `glm-5.3-flash`,从 `../dev-tools/mira/.env` 读取 `MIRA_GLM_API_KEY`。
- 模型审查结果供人工复核,按 `file:line` 与现有发现对账。**Mira 不是质量门**,不阻断合入;质量门按 ESLint、Semgrep、Qualor 和 Rust 三件的各自口径执行。

### 用法

```bash
# 在本仓库根目录执行
bash ../dev-tools/mira/review.sh             # 默认审 main...HEAD
bash ../dev-tools/mira/review.sh HEAD~1 --verbose
```

### CLI 契约(v0.11.1 实测)

- stdout 为单份 JSON,包含 `summary`、`comments`、`reviewed_files` 和 `token_usage`;`--verbose` 日志走 stderr。判断审查是否完成时结合 `summary` 和 `reviewed_files`;遇到 `Review incomplete` 检查 stderr 诊断。
- Coding Plan 的 5 小时额度耗尽时按 429 响应中的时间等待窗口重置。
- 封装把已提交的 `git diff base...HEAD` 经 stdin 传给容器内 `mira review --stdin --dry-run --output json --config /app/mira.yaml`,镜像摘要固定在 `review.sh` 与 `compose.yml`,升级须两处同步。

---

## 四、Qualor 与合并前双门禁

### 服务与项目

- 共享实例:Qualor Community `0.17.0`,只监听本机 `127.0.0.1:19080`,部署在 `../dev-tools/qualor`(compose,`restart: unless-stopped`)。就绪检查:`curl --noproxy '*' -fsS http://127.0.0.1:19080/readyz`。
- 项目:`JX-t11/AgentMesh`(id `01a2159e-cb8d-70a9-8672-6a3113c7a83c`,2026-11-26 经 API 创建),看板 http://127.0.0.1:19080 。admin 引导密码在 `../dev-tools/qualor/.env`。
- 分析器:`qualor.yml` 只开 `sonarjs`(`typeChecking: false`);eslint/semgrep 等其余分析器关闭,避免与本地门禁双引擎重复命中。范围:`web/src`、`web/scripts`、`integrations/openclaw-agentmesh/src`、`docs-site/src`、`docs-site/scripts`、`scripts`。
- Rust、shell、YAML 不在 Qualor 覆盖内:Rust 门禁见 CI,shell/YAML 安全由 Semgrep 承担。

### 合并前双门禁(Semgrep + Qualor)

候选分支合入 `main` 前必须双门禁通过,一条命令串联:

```bash
bash scripts/premerge-check.sh
```

- 门禁 1/2:Semgrep 默认规则集,命中需先定性再复扫至 0 阻断。
- 门禁 2/2:Qualor 质量门(`Qualor way`,按新增代码判定)。脚本自动创建一次性分析令牌(admin 身份,扫完即删)、临时克隆校验基线、以固定摘要的扫描容器跑已提交快照。
- main 上运行为基线刷新模式(允许本地 main 领先 origin/main);候选分支上要求本地 main 与 origin/main 一致。退出码 `1` 即未通过,不得合入。
- 首轮 main 基线:`0ef3b61`,sonarjs 命中 146 项作为存量基线,后续按新增问题判定。

---

## 五、Trivy

### 用法

`scripts/trivy-scan.sh` 通过 docker 一次性容器运行固定版本 Trivy(`0.76.2` + 镜像摘要),源码和镜像 tar 只读挂载,缓存默认放在共享目录 `../dev-tools/trivy/cache`(`AM_TRIVY_CACHE_DIR` 可覆盖)。漏洞只报告,扫描、导出或 SBOM 转换失败才返回非零。

```bash
bash scripts/trivy-scan.sh deps                  # Cargo/web/docs-site/(本地)openclaw 锁文件
bash scripts/trivy-scan.sh image agentmesh-server:local
bash scripts/trivy-scan.sh images                # 扫描本机已存在的 4 个 AgentMesh 镜像标签
```

默认输出到 `.scratch/trivy/`(已 gitignore),每个对象一份 `report.json` 和 `sbom.cdx.json`。CI 只跑 `deps`,并上传 `trivy-dependencies` artifact;镜像扫描在本地/发布前执行,因为 CI 不构建完整 Agent 镜像。

### 依赖扫描基线(2026-11-23)

| 对象 | 漏洞条目 | 说明 |
|---|---:|---|
| `Cargo.lock` | 0 | — |
| `web/package-lock.json` | 5 | 2 CRITICAL `tinypool` 1.1.1;3 MEDIUM `vitest`/`@vitest/mocker` 3.2.7 |
| `docs-site/package-lock.json` | 0 | — |
| `integrations/openclaw-agentmesh/package-lock.json` | 5 | 与 `web` 相同的 Vitest 传递依赖 |

`tinypool` 的修复版本是 2.1.1/2.1.2,`vitest` 侧修复在 4.1.11/5.0.3,因此需要升级到 Vitest 4/5 这一类主版本,不能靠补丁版本解决。升级前先跑现有前端测试和 OpenClaw 插件测试,单独评估。

### 镜像扫描基线(2026-11-23,本机镜像)

| 镜像 | 漏洞条目 | CRITICAL | HIGH |
|---|---:|---:|---:|
| `agentmesh-server:local` | 437 | 1 | 104 |
| `agentmesh-agentmesh-server:latest` | 437 | 1 | 104 |
| `agentmesh-openclaw-agent:local` | 486 | 3 | 124 |
| `agentmesh-hermes-agent:local` | 3103 | 4 | 325 |

镜像命中主要来自上游 base image(Hermes 为 `nousresearch/hermes-agent:latest`,OpenClaw 为 Node/Debian 基础镜像)及其预装依赖;当前只记录,不阻断发布。真正启用门禁前,先用同一版 Trivy 对比 PR 与目标分支,只阻断新增且有修复版本的 HIGH/CRITICAL。

## 六、Dependabot

`.github/dependabot.yml` 每周检查:

- Cargo 根依赖(`/`);
- `web/`、`integrations/openclaw-agentmesh/` 与 `docs-site/` 的 npm 依赖;
- GitHub Actions 引用。

Cargo、`web` 和 `integrations/openclaw-agentmesh` 的次版本/补丁更新合并为 `minor-and-patch` 组,`docs-site` 和 Actions 单独限额。GitHub 仓库的 `Settings → Code security` 还需分别开启 Dependabot alerts 和 Dependabot security updates;配置文件只负责版本更新 PR。

## 七、CI

`.github/workflows/ci.yml` 在 PR 和 `main` 推送时运行:

- `test`:PostgreSQL 16 service、Node 24、Rust;执行 `npm ci`、前端构建、ESLint 门禁、typed 审计、Vitest、文档站构建、双插件类型/单元测试与 E2E Compose 校验,再执行 `cargo fmt --all --check`、`cargo clippy --all-targets -- -D warnings`、覆盖率全量测试(`scripts/coverage.sh`)并上传 `coverage-reports` artifact;
- `trivy`:扫描 `Cargo.lock`、`web/`、`integrations/openclaw-agentmesh/` 与 `docs-site/` 锁文件,上传报告和 SBOM artifact,保留 30 天。

E2E 不放进 CI:它需要模型凭据、Docker 网络和真实 Agent 运行时,继续按 `scripts/e2e/verify-e2e.mjs` 本地执行。Semgrep、Qualor 和 Mira 也保持本地/手动:Semgrep 依赖共享规则缓存与登录态,Qualor 依赖本机实例,Mira 耗 GLM 额度;三者由合并前双门禁(`scripts/premerge-check.sh`)在合入前串起来。

### 工具分工与频率

| 场景 | 用什么 |
|---|---|
| 写代码时(编辑器/保存) | ESLint 实时检查 |
| 提交前 | `cd web && npm run lint`;Rust 侧 `cargo fmt --check` + `clippy -D warnings` |
| 合入 main 前 | `bash scripts/premerge-check.sh`(Semgrep 0 阻断 + Qualor 质量门 passed);需要时 `bash ../dev-tools/mira/review.sh` 供人工复核 |
| PR 前 / 定期审计 | `npm run lint:typed` + `bash scripts/trivy-scan.sh deps` |
| 发版 / 镜像更新前 | `bash scripts/trivy-scan.sh images` |
| 依赖更新 | Dependabot 周更 PR,走 CI 与人工审查 |

---

## 八、SonarQube 退役记录(2026-11-25)

- 共享 Community Build(`http://192.168.1.234:9000`,项目键 `agentmesh`)随 software-factory 的退役决定于 2026-11-25 停止;2026-11-26 巡检发现容器曾被复启,已再次 `docker compose stop`,数据卷保留。AgentMesh 的 `sonar-project.properties` 与 `scripts/sonar-scan.sh` 随之移除。
- 退役前最后基线(2026-11-26,`f2b65ad`):质量门 **OK**,新代码覆盖率 80.2%、新增违规 0、新增重复率 0.23%;整体覆盖率 84.5%,可靠性/安全/可维护性均 A,整体重复率 0.3%。历史记录见[验证记录](#九验证记录)。
- 规则衔接:TS/JS 确定性分析由 Qualor(SonarJS)+ ESLint + Semgrep 承担,Rust 维持 fmt/clippy/test + 覆盖率,AI 审查由 Mira 承担(非质量门)。原 `scripts/coverage.sh` 保留,改供 CI 上传覆盖率 artifact,未来可为 Qualor 提供 LCOV 基线。
- 若共享实例恢复服务,按 git 历史恢复两份配置并重接 `sonar-project.properties` 即可。

---

## 九、验证记录

### 2026-11-23 初测

| 项 | 命令 | 结果 |
|---|---|---|
| ESLint 门禁 | `cd web && npm run lint` | 退出码 0,首跑 0 项存量 |
| ESLint 类型审计初测 | `npm run lint:typed` | 退出码 1,80 项(58 项可自动修复) |
| ESLint 类型审计复测 | `--fix` + 手工修 22 项 | 退出码 0,0 errors / 0 warnings。手工修复分布:3 项未用类型导入、12 项 `no-base-to-string`、5 项 `require-await` |
| 回归验证 | `npx tsc --noEmit` / `npm test` | 退出码均 0;8 个测试文件 40 个测试全过 |
| Semgrep 默认扫描 | `bash scripts/semgrep-scan.sh` | 退出码 0,扫描 1011 个 git 跟踪文件,运行 295 条规则,0 命中 |
| SonarQube 守卫 | 干净 main 之前执行 `scripts/sonar-scan.sh` | 退出码 2,提示"只接受干净的 main"(脚本已随退役移除) |
| SonarQube 首扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,13.5s,基线:开放 issue 4(4 个 Rust 复杂度 hotspot),质量门 ERROR(覆盖率 0.0%) |
| Trivy 依赖扫描 | `bash scripts/trivy-scan.sh deps` | 退出码 0;`Cargo` 0、`web` 5、`docs-site` 0、本地 `openclaw` 5 |
| Trivy 镜像扫描 | `bash scripts/trivy-scan.sh images` | 退出码 0;4 个本机镜像,结果见镜像基线 |
| CI/YAML 语法 | `bash -n scripts/trivy-scan.sh` + YAML parse | 通过;`.github/` 下两份配置可解析 |

### 2026-11-25 运营改造验证

| 项 | 命令 | 结果 |
|---|---|---|
| Rust 门禁 | `cargo fmt --all --check` + `cargo clippy --all-targets -- -D warnings` + `cargo test` | 退出码均 0;新增 `operations_test` 7/7,既有回归全过 |
| 前端门禁 | `npm test --prefix web` + lint + typed lint + build | 退出码均 0;8 个文件 40 个测试全过 |
| 双插件门禁 | OpenClaw `typecheck/test/build`;Hermes `unittest` | 退出码均 0;OpenClaw 2/2,Hermes 3/3 |
| Semgrep 默认扫描 | `bash scripts/semgrep-scan.sh` | 退出码 0,扫描 1034 个 git 跟踪文件,运行 295 条规则,0 命中 |
| Trivy 依赖扫描 | `AM_TRIVY_CACHE_DIR=… bash scripts/trivy-scan.sh deps …` | 退出码 0;依赖基线与 2026-11-23 相同 |
| 4-Agent E2E | `node scripts/e2e/verify-e2e.mjs` | 退出码 0,runId `e2e-23068485`;OpenClaw 暴露 25 个契约工具,IM/forum/restart/observer/privacy/social discovery 全过 |
| 4-Agent E2E 凭证改造复验 | `node scripts/e2e/verify-e2e.mjs` | 退出码 0,runId `e2e-d94ca7fc`;E2E PG 密码按次生成后全场景仍通过 |
| SonarQube 复扫(已退役,历史) | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 对应 `6c41418`:新增违规 0,总开放 issue 4;对应 `d57d46b`:Rust 复杂度 hotspot 拆分后开放 issue 0 |
| Rust 复杂度拆分 | `cargo fmt --all --check` + clippy + `cargo test` | 退出码均 0;`high_concurrency_test` 拆分后仍 1/1 通过 |

### 2026-11-26 覆盖率接入验证(SonarQube 退役前,历史)

| 项 | 命令 | 结果 |
|---|---|---|
| 四语言覆盖率 | `bash scripts/coverage.sh` | 退出码 0;Rust 行覆盖 90.36%(5373/5946)、web 85.72%、OpenClaw 85.98%、Hermes 79% |
| 覆盖率补测 | `cargo fmt --all --check` + clippy + `cargo test` | 退出码均 0;新增 DM 生命周期 7 用例、错误映射、密码回退、`client_req_id` 重放/冲突、config/state 单测 |
| Hermes 漏洞修复复测 | `python3 -m coverage run -m unittest discover …` | 6/6 通过;`/tmp` 公共路径告警改用 mock cursor store 消除 |
| Semgrep 覆盖率改造复扫 | `bash scripts/semgrep-scan.sh` | 退出码 0,1037 个跟踪文件,295 条规则,0 命中 |
| SonarQube 质量门复扫(已退役,历史) | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 对应 `f2b65ad`;质量门 OK:新代码覆盖率 80.2%、新增违规 0、新增重复率 0.23%;整体覆盖率 84.5% |

### 2026-11-26 工具链切换验证(SonarQube → Qualor + Mira)

| 项 | 命令 | 结果 |
|---|---|---|
| ESLint 门禁复测 | `npm run lint` + `npm run lint:typed`(web/ 下) | 退出码均 0,约 4.2s |
| Semgrep 默认扫描(登录态生效) | `bash scripts/semgrep-scan.sh` | 退出码 0,1546 条规则、1036 个文件,命中 1 项(见下) |
| 命中定性 | `skills.behavioral.skill-system-prompt-extraction` @ `.agents/skills/modern-web-guidance/guides/performance/improve-next-page-load-performance.md:108` | **误报**:web 性能风格指南的 markdown 文档(「document rules over list rules」指 CSS/prefetch 规则,与提示词提取无关);vendored 技能文档重装即被覆盖,不改原文,按排除项归档 |
| `.agents` 排除后复扫 | `bash scripts/semgrep-scan.sh` | 退出码 0,1498 条规则、229 个文件,**0 命中**,13.4s |
| Qualor 项目创建 | `POST /api/v0/projects`(admin) | `JX-t11/AgentMesh` = `01a2159e-cb8d-70a9-8672-6a3113c7a83c` |
| 合并前双门禁 main 模式 | `bash scripts/premerge-check.sh` | 退出码 0,21.9s;Semgrep 0 阻断;Qualor sonarjs 2.7s、61 文件、存量 146 findings,分析 `01a215a1-50aa-7717-a8c3-d4ef5753a960` 入库,质量门 **passed**;分析令牌创建/删除正常 |
| Mira CLI 审查 | `bash ../dev-tools/mira/review.sh HEAD~1 --verbose` | 退出码 0,7.8s;stdout 单份 JSON(`jq` 解析通过),纯文档 diff 无发现,未遇 429 |
| Semgrep Rust 覆盖实测 | 默认规则集扫构造样例 `vuln.rs`(AWS key / ghp_ token / 硬编码密码 / `sh -c` 拼接 / MD5) | rust 规则 49 条 + multilang 39 条在 `.rs` 上运行;AWS key 命中 `generic.secrets.detected-aws-access-key-id-value`,官方示例值 allowlist;ghp_ token、硬编码密码、`sh -c` 注入形态、MD5 弱哈希均未命中——Rust 深度安全规则覆盖有限,见第二节修正后的表述 |
