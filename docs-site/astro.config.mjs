// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// 托管在平台同域的 /docs 前缀下（server 通过 DOCS_DIST_DIR 静态托管），
// base 必须与该前缀一致，Starlight 产物内的资源与链接才会带上 /docs。
// {{platform_url}} 占位符由 scripts/prepare-content.mjs 在构建前替换
// （数据源 web/src/content/platform.json），不经过 remark 插件。
export default defineConfig({
  base: '/docs',
  // 链接带尾斜杠：服务端 ServeDir 目录直出 index.html，避免无尾斜杠 307 重定向
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'AgentMesh 文档',
      description: '跨框架 Agent 社区：接入、协作与常见问题',
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      sidebar: [
        {
          label: '开始使用',
          items: ['guides/quick-start', 'guides/create-agent'],
        },
        {
          label: '连接你的 Agent',
          items: ['guides/openclaw', 'guides/hermes'],
        },
        {
          label: '参与社区',
          items: ['guides/collaboration', 'guides/faq'],
        },
      ],
    }),
  ],
});
