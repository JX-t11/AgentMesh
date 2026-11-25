# 代码质量、依赖与镜像安全检查:ESLint · Semgrep · SonarQube · Trivy · Dependabot

ESLint、Semgrep、Trivy 在本地运行;SonarQube 的共享看板跟踪 `main` 基线;Dependabot 和 CI 在 GitHub 上运行。配置方法沿用 [software-factory 同名文档](../../software-factory/.agents/eslint-semgrep-sonarqube.md),按本仓库结构(Rust 服务端、`web/` 与 `docs-site/` 两个 npm 工程)适配。

| 工具 | 角色 | 运行方式 | 范围 |
|---|---|---|---|
| ESLint + typescript-eslint | 本地提交门禁与类型审计 | npm scripts,编辑器实时 | `web/` 的 JS、TS 和 TSX |
| Semgrep | 安全模式审计(OWASP/CI/密钥) | docker 一次性容器 | 仓库根全部代码(含 shell、YAML、Dockerfile、Rust) |
| SonarQube | 跟踪质量指标与质量门 | 共享或隔离实例与一次性扫描容器 | 共享实例只接收干净的 `main`,隔离实例可分析分支和工作区改动 |
| Trivy | 依赖与镜像漏洞、SBOM | docker 一次性容器 | npm 锁文件、本机 AgentMesh 镜像 |
| Dependabot | 依赖版本更新 PR | GitHub 默认分支配置 | Cargo、`web/`、`docs-site/`、GitHub Actions |
| GitHub Actions | 提交门禁 | PR 与 `main` 推送 | Rust、前端、文档、Trivy 依赖扫描 |

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

### 当前基线(2026-11-23 实测)

`npm run lint` 首跑即以退出码 `0` 通过,存量 0 项。`npm run lint:typed` 初测 80 项:58 项 `--fix` 自动清除(多余断言为主),手工修复 22 项后复测退出码 `0`。同轮 `npx tsc --noEmit` 退出码 0,`npm test` 的 8 个文件 40 个测试全部通过。

手工修复的 22 项分布:

| 条数 | 规则 | 修法 |
|---|---|---|
| 3 | `no-unused-vars`(类型) | 删除 `decoders.ts` 未使用的 `BoardVisibility`/`GroupJoinPolicy`/`GroupVisibility` 导入 |
| 12 | `no-base-to-string` | fetch mock 的 `input.toString()` 改 `input instanceof URL ? input.href : input.url`;`String(init?.body ?? '{}')` 改 `typeof init?.body === 'string'` 窄化;`FormData.get` 结果经 `typeof value === 'string'` 收窄 |
| 5 | `require-await` | 测试 fetch mock 去掉 `async`,赋值处 `as unknown as typeof fetch`;协调器 stub 单返回点改 `Promise.resolve(...)` |

### 维护口径

提交 `web/` 代码前运行 `npm run lint`,以退出码 `0` 为通过条件;定期(改动面大或 PR 前)运行 `npm run lint:typed`,同一口径核对新增命中。

---

## 二、Semgrep

### 安装

不需要本机安装 CLI:`scripts/semgrep-scan.sh` 用 **docker 一次性容器**(`--rm`,镜像只在首次 pull,之后走本地缓存;源码 `:ro` 挂载,退出即清理,扫描器物理上改不了仓库)。

### 共享规则缓存

规则集首次运行从 semgrep registry 联网拉取,缓存指向跨项目共享目录:

```
/home/jx03/work_lumin/llm_train/code-workplace/dev-tools/semgrep/home
```

脚本把容器 `HOME` 挂到这里。**已知现状**:该目录当前归 root 所有,普通用户不可写,脚本按设计回退到临时缓存并输出 `WARN`(与 software-factory 相同逻辑)——即每次扫描会重新联网拉规则。要让缓存生效,需要一次 `sudo chown -R $(id -u):$(id -g) dev-tools/semgrep/home`。

### 用法(仓库根目录)

```bash
bash scripts/semgrep-scan.sh                            # 默认 p/owasp-top-ten + p/ci + p/secrets
bash scripts/semgrep-scan.sh p/javascript               # 指定单个规则集
bash scripts/semgrep-scan.sh p/owasp-top-ten p/rust     # 指定多组规则
```

每个位置参数对应一个规则配置。传入含空格的路径时,用引号包住整个路径。

已排除:`.git`、`target`(Rust 构建产物,7.2G)、`node_modules`、`dist`、`coverage`。Semgrep 是本仓库 **Rust / shell / YAML** 的唯一静态安全覆盖(SonarQube Community 不支持这些语言)。

---

## 三、SonarQube(共享看板)

### 现状

- 共享实例:dev-tools 部署的 SonarQube Community Build,`http://192.168.1.234:9000`(本机别名 `http://127.0.0.1:9000`)
- 项目键:`agentmesh`,看板 http://192.168.1.234:9000/dashboard?id=agentmesh
- 凭据:`../dev-tools/sonarqube/credentials.txt`(token 存在这里,日常扫描不用 admin)
- 接入配置:仓根 `sonar-project.properties`(`sonar.typescript.tsconfigPaths=web/tsconfig.json`)

### 关键限制(Community Build)

- **只扫默认分支**:共享实例只接受干净的 `main`(`scripts/sonar-scan.sh` 内置守卫,非干净 main 直接退出码 2);特性分支/工作区改动要扫需自建隔离实例(`SONAR_HOST_URL` 指向它)。本地增量反馈交给 ESLint/Semgrep。
- 语言覆盖:TS/JS/TSX、CSS、Dockerfile;当前实例也会分析 Rust(扫描日志包含 `rust:S3776`)。Rust 的提交门禁仍以 `cargo fmt`、`clippy -D warnings` 和 `cargo test` 为准,SonarQube 只作为趋势看板。YAML 和 shell 不在 SonarQube 覆盖内,由 Semgrep 承担。

### 用法

```bash
SONAR_TOKEN=<token> bash scripts/sonar-scan.sh          # 只在干净 main 上
# 看指标
curl -s -u "<token>:" "http://192.168.1.234:9000/api/measures/component?component=agentmesh&metricKeys=bugs,code_smells,vulnerabilities" | jq
# 看 issue
curl -s -u "<token>:" "http://192.168.1.234:9000/api/issues/search?componentKeys=agentmesh&resolved=false&ps=500" | jq
```

性能参考:46 个源文件(含 Rust)约 13.5s 扫完,服务端异步处理约 1–2 分钟。

### 当前 main 基线(2026-11-25,对应 `d57d46b`)

| 指标 | 值 |
|---|---|
| 开放 issue | 0 = 0 BUG + 0 Code Smell + 0 Vulnerability |
| 评级 | 可靠性 A / 安全 A / 可维护性 A,重复率 1.5%,安全热点 0 |
| 质量门 | ERROR:新代码覆盖率 0.0%(门槛 80%);新增违规与重复率条件通过 |

历史首扫的 TS/Docker/`secrets:S6698` 命中已由 `1dbddcb` 清理;4 个 Rust 认知复杂度 hotspots 已由 `d57d46b` 拆分消除。质量门唯一失败项是覆盖率。仓库尚未生成并上传 LCOV,这里不伪造覆盖率报告;补齐 `web` 覆盖率后再复扫,才能判断新代码 80% 门槛是否真实可达。

### 工具分工与频率

| 场景 | 用什么 |
|---|---|
| 写代码时(编辑器/保存) | ESLint 实时检查 |
| 提交前 | `cd web && npm run lint` |
| PR 前 / 定期审计 | `npm run lint:typed` + `bash scripts/semgrep-scan.sh` + `bash scripts/trivy-scan.sh deps` |
| main 收敛趋势 / 发版前 | `scripts/sonar-scan.sh` + 看板 |
| 依赖更新 | Dependabot 周更 PR,走 CI 与人工审查 |
| 图片/制品发布前 | `bash scripts/trivy-scan.sh images` |

TS/JS 安全规则族 SonarQube 与 Semgrep 高度重叠(S4036、S5332 同族规则两边都有);当前 Semgrep 0 命中,重叠意味着不期待双份发现。SonarQube 独有价值是**跨版本趋势与质量口径看板**,Semgrep 独有价值是 **Rust/shell/YAML 盲区**,ESLint 独有价值是**工作区实时反馈**。

---

## 四、Trivy

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

`tinypool` 的修复版本是 2.1.1/2.1.2,`vitest` 侧修复在 4.1.11/5.0.3,因此需要升级到 Vitest 4/5 这一类主版本,不能靠补丁版本解决。升级前先跑现有 40 个前端测试和 OpenClaw 插件测试,单独评估。

### 镜像扫描基线(2026-11-23,本机镜像)

| 镜像 | 漏洞条目 | CRITICAL | HIGH |
|---|---:|---:|---:|
| `agentmesh-server:local` | 437 | 1 | 104 |
| `agentmesh-agentmesh-server:latest` | 437 | 1 | 104 |
| `agentmesh-openclaw-agent:local` | 486 | 3 | 124 |
| `agentmesh-hermes-agent:local` | 3103 | 4 | 325 |

镜像命中主要来自上游 base image(Hermes 为 `nousresearch/hermes-agent:latest`,OpenClaw 为 Node/Debian 基础镜像)及其预装依赖;当前只记录,不阻断发布。真正启用门禁前,先用同一版 Trivy 对比 PR 与目标分支,只阻断新增且有修复版本的 HIGH/CRITICAL。

## 五、Dependabot

`.github/dependabot.yml` 每周检查:

- Cargo 根依赖(`/`);
- `web/`、`integrations/openclaw-agentmesh/` 与 `docs-site/` 的 npm 依赖;
- GitHub Actions 引用。

Cargo、`web` 和 `integrations/openclaw-agentmesh` 的次版本/补丁更新合并为 `minor-and-patch` 组,`docs-site` 和 Actions 单独限额。GitHub 仓库的 `Settings → Code security` 还需分别开启 Dependabot alerts 和 Dependabot security updates;配置文件只负责版本更新 PR。

## 六、CI

`.github/workflows/ci.yml` 在 PR 和 `main` 推送时运行:

- `test`:PostgreSQL 16 service、Node 24、Rust;执行 `npm ci`、前端构建、ESLint 门禁、typed 审计、Vitest、文档站构建、双插件类型/单元测试与 E2E Compose 校验,再执行 `cargo fmt --all --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --all-targets`;
- `trivy`:扫描 `Cargo.lock`、`web/`、`integrations/openclaw-agentmesh/` 与 `docs-site/` 锁文件,上传报告和 SBOM artifact,保留 30 天。

E2E 不放进 CI:它需要模型凭据、Docker 网络和真实 Agent 运行时,继续按 `scripts/e2e/verify-e2e.mjs` 本地执行。Semgrep 和 SonarQube 也保持本地/手动,原因分别是规则缓存与共享实例的干净 `main` 限制。Qualor 暂未接入:共享 Qualor 实例还没有 `agentmesh` 项目和令牌,需要时先按参考文档建项目,再补 `qualor.yml` 和扫描容器命令。

## 七、验证记录

### 2026-11-23 初测

| 项 | 命令 | 结果 |
|---|---|---|
| ESLint 门禁 | `cd web && npm run lint` | 退出码 0,首跑 0 项存量 |
| ESLint 类型审计初测 | `npm run lint:typed` | 退出码 1,80 项(58 项可自动修复) |
| ESLint 类型审计复测 | `--fix` + 手工修 22 项 | 退出码 0,0 errors / 0 warnings |
| 回归验证 | `npx tsc --noEmit` / `npm test` | 退出码均 0;8 个测试文件 40 个测试全过 |
| Semgrep 默认扫描 | `bash scripts/semgrep-scan.sh` | 退出码 0,扫描 1011 个 git 跟踪文件,运行 295 条规则,**0 命中** |
| SonarQube 守卫 | 干净 main 之前执行 `scripts/sonar-scan.sh` | 退出码 2,提示"只接受干净的 main" |
| SonarQube 首扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,13.5s,分析报告上传成功,基线见上表 |
| SonarQube 复扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,对应 `1dbddcb`;4 个 Rust 复杂度,质量门 ERROR(覆盖率 0.0%) |
| Trivy 依赖扫描 | `bash scripts/trivy-scan.sh deps` | 退出码 0;`Cargo` 0、`web` 5、`docs-site` 0、本地 `openclaw` 5 |
| Trivy 镜像扫描 | `bash scripts/trivy-scan.sh images` | 退出码 0;4 个本机镜像,结果见镜像基线 |
| CI/YAML 语法 | `bash -n scripts/trivy-scan.sh` + YAML parse | 通过;`.github/` 下两份配置可解析 |

### 2026-11-25 运营改造验证

| 项 | 命令 | 结果 |
|---|---|---|
| Rust 门禁 | `cargo fmt --all --check` + `cargo clippy --all-targets -- -D warnings` + `cargo test` | 退出码均 0;新增 `operations_test` 7/7,既有回归全过 |
| 前端门禁 | `npm test --prefix web` + lint + typed lint + build | 退出码均 0;8 个文件 40 个测试全过 |
| 双插件门禁 | OpenClaw `typecheck/test/build`;Hermes `unittest` | 退出码均 0;OpenClaw 2/2,Hermes 3/3 |
| Semgrep 默认扫描 | `bash scripts/semgrep-scan.sh` | 退出码 0,扫描 1034 个 git 跟踪文件,运行 295 条规则,**0 命中** |
| Trivy 依赖扫描 | `AM_TRIVY_CACHE_DIR=… bash scripts/trivy-scan.sh deps …` | 退出码 0;依赖基线与 2026-11-23 相同(Cargo 0,web 5,docs-site 0,openclaw 5) |
| 4-Agent E2E | `node scripts/e2e/verify-e2e.mjs` | 退出码 0,runId `e2e-23068485`;OpenClaw 暴露 25 个契约工具,IM/forum/restart/observer/privacy/social discovery 全过 |
| 4-Agent E2E 凭证改造复验 | `node scripts/e2e/verify-e2e.mjs` | 退出码 0,runId `e2e-d94ca7fc`;E2E PG 密码按次生成后全场景仍通过 |
| SonarQube 复扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,对应 `6c41418`;新增违规 0,总开放 issue 4(全部历史 Rust 复杂度),漏洞 0;质量门仅剩新代码覆盖率 0.0% |
| Rust 复杂度拆分 | `cargo fmt --all --check` + clippy + `cargo test` | 退出码均 0;`high_concurrency_test` 拆分后仍 1/1 通过 |
| SonarQube 复杂度复扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,对应 `d57d46b`;开放 issue 0,Code Smell 0,新增违规 0 |
| Semgrep 复杂度改造复扫 | `bash scripts/semgrep-scan.sh` | 退出码 0,1034 个跟踪文件,295 条规则,0 命中 |
