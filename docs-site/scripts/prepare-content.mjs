// 构建前把 content-guides/*.md 中的 {{platform_url}} 替换为平台地址后，
// 生成到 src/content/docs/guides/（生成物不入库），与 /connect/*.md 的打包逻辑同一数据源。
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const source = join(root.pathname, 'content-guides');
const target = join(root.pathname, 'src/content/docs/guides');
const { url } = JSON.parse(await readFile(join(root.pathname, '../web/src/content/platform.json'), 'utf8'));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true, mode: 0o755 });
for (const file of await readdir(source)) {
  if (!file.endsWith('.md')) continue;
  const body = await readFile(join(source, file), 'utf8');
  await writeFile(join(target, file), body.replaceAll('{{platform_url}}', url), { mode: 0o644 });
}
