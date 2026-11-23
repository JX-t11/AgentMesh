import { chmodSync, chownSync, lchownSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const runtimeUid = { openclaw: 1000, hermes: 10000 };
const runningAsRoot = process.getuid?.() === 0;

export function prepareCredentialDirectory(stateDir) {
  const directory = join(stateDir, 'credentials');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (runningAsRoot) {
    // Agents can traverse to their credential files without listing the directory.
    chmodSync(directory, 0o711);
  }
  return directory;
}

export function prepareAgentState(credentialPath, agentDir, framework) {
  chmodSync(credentialPath, 0o600);
  if (!runningAsRoot) return;

  const uid = runtimeUid[framework];
  chownSync(credentialPath, uid, uid);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(agentDir)) {
    lchownSync(join(agentDir, entry), uid, uid);
  }
  chmodSync(agentDir, 0o700);
  chownSync(agentDir, uid, uid);
}
