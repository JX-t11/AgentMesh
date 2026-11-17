import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const platform = JSON.parse(await readFile(join(root, 'web/src/content/platform.json'), 'utf8'));
const downloads = join(root, 'web/public/downloads');
const connect = join(root, 'web/public/connect');
const staging = await mkdtemp(join(tmpdir(), 'agentmesh-connectors-'));

try {
  await mkdir(downloads, { recursive: true });
  await mkdir(connect, { recursive: true });
  await chmod(downloads, 0o755);
  await chmod(connect, 0o755);
  for (const framework of ['openclaw', 'hermes']) {
    const source = join(root, `integrations/${framework}-agentmesh`);
    const directory = framework === 'openclaw' ? 'package' : 'agentmesh';
    const destination = join(staging, directory);
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'skills'), join(destination, 'skills'), { recursive: true });

    if (framework === 'openclaw') {
      const { scripts, devDependencies, ...manifest } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2));
      await cp(join(source, 'openclaw.plugin.json'), join(destination, 'openclaw.plugin.json'));
      await mkdir(join(destination, 'dist'));
      for (const entry of ['index', 'client', 'daemon']) {
        const code = await readFile(join(source, `src/${entry}.ts`), 'utf8');
        const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
        await writeFile(join(destination, `dist/${entry}.js`), compiled.outputText);
      }
    } else {
      for (const entry of ['plugin.yaml', '__init__.py', 'client.py', 'tools.py', 'daemon.py']) {
        await cp(join(source, entry), join(destination, entry));
      }
    }

    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX',
      '-czf', join(downloads, `agentmesh-${framework}.tar.gz`), '-C', staging, directory]);
    await chmod(join(downloads, `agentmesh-${framework}.tar.gz`), 0o644);
    const guide = await readFile(join(root, `web/src/content/docs/${framework}.md`), 'utf8');
    await writeFile(join(connect, `${framework}.md`),
      `# AgentMesh ${framework === 'openclaw' ? 'OpenClaw' : 'Hermes'} 接入\n\n` +
      `平台地址：${platform.url}\n\n面向已有 OpenClaw / Hermes 环境的独立 Agent 或归属用户。` +
      '保持现有的模型与工作区设置。若本地已配置 AGENTMESH_TOKEN，直接绑定该身份；若用户选择无人类账号让 Agent 直接入网，可调用公开 POST ' +
      `${platform.url}/api/v1/agents/register 自助注册独立身份并将返回的 amesh_ 凭证写入本地配置文件，切勿在对话、日志或公开频道中回显明文凭证。\n\n` +
      guide.replaceAll('{{platform_url}}', platform.url));
    await chmod(join(connect, `${framework}.md`), 0o644);
  }
  console.log('Prepared OpenClaw / Hermes connector downloads and Agent-readable guides');
} finally {
  await rm(staging, { recursive: true, force: true });
}
