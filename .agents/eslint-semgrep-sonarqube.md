# 本地代码质量检查:ESLint + typescript-eslint · Semgrep · SonarQube

ESLint 和 Semgrep 在本地运行。SonarQube 的共享看板跟踪 `main` 基线,分支和工作区改动在隔离实例分析。配置方法沿用 [software-factory 同名文档](../../software-factory/.agents/eslint-semgrep-sonarqube.md),按本仓库结构(单 npm 工程 `web/`,Rust 服务端)适配。

| 工具 | 角色 | 运行方式 | 范围 |
|---|---|---|---|
| ESLint + typescript-eslint | 本地提交门禁与类型审计 | npm scripts,编辑器实时 | `web/` 的 JS、TS 和 TSX |
| Semgrep | 安全模式审计(OWASP/CI/密钥) | docker 一次性容器 | 仓库根全部代码(含 shell、YAML、Dockerfile、Rust) |
| SonarQube | 跟踪质量指标与质量门 | 共享或隔离实例与一次性扫描容器 | 共享实例只接收干净的 `main`,隔离实例可分析分支和工作区改动 |

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
- 语言覆盖:TS/JS/TSX、CSS、Dockerfile;**不支持 Rust、YAML、shell**。本仓库服务端 `src/` 是 Rust,不进 SonarQube——这部分的质量与安全口径由 cargo/clippy 与 Semgrep 承担。

### 用法

```bash
SONAR_TOKEN=<token> bash scripts/sonar-scan.sh          # 只在干净 main 上
# 看指标
curl -s -u "<token>:" "http://192.168.1.234:9000/api/measures/component?component=agentmesh&metricKeys=bugs,code_smells,vulnerabilities" | jq
# 看 issue
curl -s -u "<token>:" "http://192.168.1.234:9000/api/issues/search?componentKeys=agentmesh&resolved=false&ps=500" | jq
```

性能参考:15.8k 行(计入 44 个 TS/JS 源文件与 Dockerfile)约 13.5s 扫完,服务端异步处理约 1–2 分钟。

### 当前 main 基线(2026-11-23,对应 `ca44fcf`)

| 指标 | 值 |
|---|---|
| 开放 issue | 15 = 2 BUG + 6 Code Smell + 7 Vulnerability |
| 严重度 | BLOCKER 1 / CRITICAL 2 / MAJOR 6 / MINOR 6 |
| 评级 | 可靠性 D / 安全 E / 可维护性 A,重复率 1.2%,安全热点 0 |

Issue 明细:

| 严重度 | 类型 | 规则 | 位置 |
|---|---|---|---|
| BLOCKER | Vulnerability | secrets:S6698 | `compose.yaml` |
| CRITICAL | BUG | javascript:S2871 | `scripts/e2e/verify-e2e.mjs` |
| CRITICAL | BUG | typescript:S2871 | `web/src/App.tsx` |
| MAJOR | Code Smell | javascript:S8786 | `scripts/e2e/bootstrap.mjs` |
| MAJOR | Code Smell | typescript:S6845 | `web/src/components/ForumWorkspace.tsx` |
| MAJOR | Code Smell | typescript:S6845 | `web/src/components/MarkdownContent.tsx` |
| MAJOR | Code Smell | typescript:S6848 | `web/src/components/NavigationLink.tsx` |
| MAJOR | Code Smell | typescript:S8786 | `web/src/api/client.ts` |
| MAJOR | Code Smell | typescript:S8786 | `web/src/components/MarkdownContent.tsx` |
| MINOR | Vulnerability | docker:S6471 | `docker/Dockerfile.hermes-agent` |
| MINOR | Vulnerability | docker:S6471 | `docker/Dockerfile.openclaw-agent` |
| MINOR | Vulnerability | docker:S6471 | `docker/Dockerfile.server` |
| MINOR | Vulnerability | javascript:S4036 | `scripts/e2e/verify-e2e.mjs` |
| MINOR | Vulnerability | javascript:S4036 | `web/scripts/package-connectors.mjs` |
| MINOR | Vulnerability | javascript:S5332 | `scripts/e2e/verify-e2e.mjs` |

已人工抽查定性:`secrets:S6698` 命中的是 compose 里 `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-agentmesh_dev}` 的**本地开发缺省值**(`ADMIN_TOKEN` 用 `:?` 强制必填,无硬编码生产凭据),网页端可标 won't fix 或改用 `.env` 注入。其余 14 项待逐条定性后补充本节。

### 三工具分工与频率

| 场景 | 用什么 |
|---|---|
| 写代码时(编辑器/保存) | ESLint 实时检查 |
| 提交前 | `cd web && npm run lint` |
| PR 前 / 定期审计 | `npm run lint:typed` + `bash scripts/semgrep-scan.sh` |
| main 收敛趋势 / 发版前 | `scripts/sonar-scan.sh` + 看板 |

TS/JS 安全规则族 SonarQube 与 Semgrep 高度重叠(S4036、S5332 同族规则两边都有);当前 Semgrep 0 命中,重叠意味着不期待双份发现。SonarQube 独有价值是**跨版本趋势与质量口径看板**,Semgrep 独有价值是 **Rust/shell/YAML 盲区**,ESLint 独有价值是**工作区实时反馈**。

---

## 四、验证记录

### 2026-11-23 初测

| 项 | 命令 | 结果 |
|---|---|---|
| ESLint 门禁 | `cd web && npm run lint` | 退出码 0,首跑 0 项存量 |
| ESLint 类型审计初测 | `npm run lint:typed` | 退出码 1,80 项(58 项可自动修复) |
| ESLint 类型审计复测 | `--fix` + 手工修 22 项 | 退出码 0,0 errors / 0 warnings |
| 回归验证 | `npx tsc --noEmit` / `npm test` | 退出码均 0;8 个测试文件 40 个测试全过 |
| Semgrep 默认扫描 | `bash scripts/semgrep-scan.sh` | 退出码 0,扫描 1003 个文件,运行 293 条规则,**0 命中** |
| SonarQube 守卫 | 干净 main 之前执行 `scripts/sonar-scan.sh` | 退出码 2,提示"只接受干净的 main" |
| SonarQube 首扫 | `SONAR_TOKEN=… bash scripts/sonar-scan.sh` | 退出码 0,13.5s,分析报告上传成功,基线见上表 |
