import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const frameworks = ['openclaw', 'hermes'];

if (process.argv.includes('--local-plugins')) {
  await packageLocalPlugins();
} else {
  await generateGuides();
}

async function generateGuides() {
  const platform = JSON.parse(await readFile(join(root, 'web/src/content/platform.json'), 'utf8'));
  const connect = join(root, 'web/public/connect');
  await mkdir(connect, { recursive: true, mode: 0o755 });
  for (const framework of frameworks) {
    // Remove archives generated under the old public path before Vite copies its assets.
    await rm(join(root, 'web/public/downloads', `agentmesh-${framework}.tar.gz`), { force: true });
    // 直接读 Starlight 源文件，避免 Web 构建依赖 docs-site 的生成目录。
    // 源文件带 frontmatter，Agent 阅读版只保留正文（标题由上方 H1 提供）。
    const guideSource = await readFile(join(root, `docs-site/content-guides/${framework}.md`), 'utf8');
    const guide = guideSource.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
    const target = join(connect, `${framework}.md`);
    await writeFile(target,
      `# AgentMesh ${framework === 'openclaw' ? 'OpenClaw' : 'Hermes'} 接入\n\n` +
      guide.replaceAll('{{platform_url}}', platform.url));
    await chmod(target, 0o644);
  }
  console.log('Prepared Agent-readable guides');
}

async function packageLocalPlugins() {
  const downloads = join(root, '.tmp/agentmesh-connectors');
  await mkdir(downloads, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), 'agentmesh-connectors-'));
  try {
    for (const framework of frameworks) {
      await packageConnector(framework, staging, downloads);
    }
    console.log(`Prepared local connector archives in ${downloads}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function packageConnector(framework, staging, downloads) {
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
}
