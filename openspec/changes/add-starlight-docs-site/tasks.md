# Tasks

## 1. 文档站与平台接入

- [x] 1.1 核对 `docs-site/` 的 Starlight 配置、`content-guides/` 源文件、`scripts/prepare-content.mjs` 与 `src/content/docs/index.md`，确认生成目录和构建产物不进入 Git；通过 `git status --untracked-files=all docs-site` 验证只剩源文件、配置与锁文件待入库。
- [x] 1.2 确认 React 文档工作区已移除，平台侧栏、首页、凭证弹窗和用户控制台的文档链接全部指向 `/docs/guides/{framework}/`；通过 `npm --prefix web test` 与源码检索验证无残留 `DocsWorkspace`、`documentation.ts` 或旧 `/docs/{slug}` 链接。
- [x] 1.3 确认 `DOCS_DIST_DIR` 配置、`/docs` 静态挂载和目录重定向前缀改写已接入服务端；用本地服务与 `curl` 验证指南页、静态资源和 307 重定向。

## 2. 修复构建依赖与格式

- [x] 2.1 修改 `web/scripts/package-connectors.mjs` 直接读取 `docs-site/content-guides/*.md`，删除 `docker/Dockerfile.server` 中为 Web 构建复制生成指南的步骤；移走 `docs-site/src/content/docs/guides/` 后运行 `npm --prefix web run build`，确认仍能生成 `/connect/*.md` 且无 frontmatter/占位符。
- [x] 2.2 运行 `cargo fmt --all` 修正 `src/routes/mod.rs` 的格式；通过 `cargo fmt --all --check`。

## 3. 旧 URL 兼容

- [x] 3.1 在文档挂载分支注册六个旧 slug 的 308 永久重定向；用 `curl` 验证 `/docs/quick-start`、`create-agent`、`openclaw`、`hermes`、`collaboration`、`faq` 均指向 `/docs/guides/{slug}/`，且 `/docs/guides/*` 与静态资源不受影响。
- [x] 3.2 扩展 `tests/common/mod.rs` 支持同时注入 Web 与文档产物目录，在 `tests/static_web_test.rs` 覆盖文档首页、指南页、静态资源、Location 前缀、旧 URL 308 与 API JSON 404；运行 `cargo test --test static_web_test`。

## 4. 仓库与构建产物边界

- [x] 4.1 在 `.gitignore` 与 `.dockerignore` 增加 `docs-site/.astro/`，确认 `docs-site/dist/`、`docs-site/node_modules/`、`docs-site/src/content/docs/guides/` 已被忽略；用 `git check-ignore -v` 验证。
- [x] 4.2 确认 `docs-site` 的配置、脚本、`content-guides/`、`src/content/docs/index.md` 和锁文件未被忽略；输出待入库文件清单，不在本次执行提交。

## 5. 集成验收

- [x] 5.1 运行 `cargo check --all-targets`、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --all --check` 与 `cargo test --test static_web_test`，记录结果。
- [x] 5.2 运行 `npm --prefix web test` 与 `npm --prefix web run build`；在移除生成指南目录的情况下重复构建，确认干净工作区可用。
- [x] 5.3 用 Node 24 容器执行 `npm --prefix docs-site run build`，启动设置 `DOCS_DIST_DIR` 的服务并验证 `/docs/`、六篇指南、Pagefind、`/docs/guides/openclaw` 的 307、六个旧 URL 的 308、`/api/v1/*` 的 JSON 404 与 favicon 之外的静态资源。

## Workflow follow-up

- 归档前更新 `README.md`、`docs/web-ui.md`、`ROADMAP.md` 的文档站路径与锚点，并在 `CHANGELOG/Unreleased.md` 记录本次用户可见变更。
- 归档前处理文档站体验项：返回平台入口、`docs-site/public/favicon.svg`、Vite 开发代理与 `DOCS_DIST_DIR` 默认值。
- 按项目评审要求完成后归档 change。
