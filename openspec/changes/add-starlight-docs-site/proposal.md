# Proposal

## Why

接入文档目前以内嵌 React 工作区形式存在，正文、目录和导航都由前端手写维护，缺少全文搜索、版本化侧栏和独立的静态站点构建流程。把文档迁到 Starlight 后，文档可以独立构建、被搜索引擎索引，并由同一个 Rust 服务在 `/docs` 托管；同时需要收尾当前迁移中的构建依赖、旧 URL 兼容和仓库卫生问题，避免干净克隆无法构建或已发布链接失效。

## What Changes

- 新增 `docs-site/` Starlight 站点，`base` 固定为 `/docs`；六篇接入指南以 `docs-site/content-guides/*.md` 为唯一源文件，构建前替换 `{{platform_url}}` 并生成 `src/content/docs/guides/`；站点提供分组侧栏、Pagefind 搜索和前后篇导航。
- **BREAKING**：文档从 React 工作区迁出，`/docs` 及 `/docs/guides/{slug}/` 由服务端直接托管 Starlight 产物；旧地址 `/docs/{slug}`（`quick-start`、`create-agent`、`openclaw`、`hermes`、`collaboration`、`faq`）永久重定向到对应指南。
- Rust 服务新增 `DOCS_DIST_DIR`，默认 `docs-site/dist`：产物入口存在时在 `/docs` 前缀挂载，保留目录重定向的 `/docs` 前缀；显式设为空值或产物缺失时 `/docs` 仍走 SPA 回退。Docker 镜像同时构建 Web 与文档站，`compose.yaml` 设置 `DOCS_DIST_DIR=/app/docs/dist`。
- 移除 `DocsWorkspace`、`documentation.ts`、`web/src/content/docs/` 及对应样式和测试；平台侧栏、首页、凭证弹窗和用户控制台的文档链接改为指向 `/docs/guides/{framework}/` 的普通链接。
- `web/scripts/package-connectors.mjs` 直接读取 `docs-site/content-guides/*.md` 生成 `/connect/*.md`，不再要求先执行文档站构建；移除 Dockerfile 中为绕过该依赖而复制生成目录的步骤。
- 仓库忽略 `docs-site/.astro/`、`docs-site/dist/`、`docs-site/node_modules/` 与生成的 `docs-site/src/content/docs/guides/`；文档站源码、锁文件与首页 `index.md` 纳入 Git。
- 文档站补齐导航与本地开发体验：侧栏新增“返回平台”入口，提供 favicon 与 Starlight 404 页面；`docs-site/package.json` 声明 Node `>=22.23.4`，Vite dev server 将 `/docs` 代理到后端，未设置 `DOCS_DIST_DIR` 时默认读取 `docs-site/dist`。
- 补充服务端文档挂载与旧 URL 重定向测试，并修复当前工作区的 rustfmt 失败。

## Capabilities

### New Capabilities

- `documentation-site`：Starlight 文档站的构建、`/docs` 静态托管、指南路由、旧 URL 兼容、内容源与仓库产物边界。

## Impact

- Rust：`src/config.rs`、`src/state.rs`、`src/main.rs`、`src/routes/mod.rs` 增加文档目录配置、静态挂载、前缀保留和旧路径重定向；`tests/common/mod.rs`、`tests/static_web_test.rs` 增加文档托管覆盖。
- 前端：删除 `web/src/components/DocsWorkspace.tsx`、`documentation.ts`、`content/docs/*.md`，调整 `App.tsx`、`navigation.ts`、`TopBar.tsx`、`PlatformSidebar.tsx`、`HomeWorkspace.tsx`、`AuthModal.tsx`、`UserConsoleDrawer.tsx` 与相关测试；清理 `app.css` 中无引用的 `.docs-*` 样式。
- 文档站：新增 `docs-site/`（Astro/Starlight、`astro.config.mjs`、`scripts/prepare-content.mjs`、`content-guides/`、`src/content/docs/index.md`、`src/content/docs/404.md`、`public/favicon.svg`、锁文件与 Node 版本声明）。
- 构建与部署：`docker/Dockerfile.server` 增加 docs-builder 阶段；`compose.yaml`、`.env.example`、`README.md` 增加 `DOCS_DIST_DIR` 与文档站构建说明；`web/vite.config.ts` 将 `/docs` 代理到后端。
- 兼容性：旧 `/docs/{slug}` 通过永久重定向保持可用；`/connect/{framework}.md` 内容继续生成且继续替换平台地址；`/docs` 未托管时仍走既有 SPA 回退。
- 验证：`cargo fmt --all --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --test static_web_test`、`npm --prefix web test`、`npm --prefix web run build`、`npm --prefix docs-site run build`，以及实际服务的 `/docs`、静态资源、favicon、404、重定向、Vite `/docs` 代理和 API 404 检查。
