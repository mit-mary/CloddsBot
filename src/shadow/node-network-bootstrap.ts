import { execFileSync, spawn } from 'node:child_process';

const BOOTSTRAP_MARKER = 'CLODDS_SHADOW_NETWORK_BOOTSTRAPPED';

function windowsSystemProxy(targetUrl: string): string | null {
  if (process.platform !== 'win32') return null;
  const script = [
    `$target=[Uri]'${targetUrl.replaceAll("'", "''")}'`,
    '$proxy=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($target)',
    "if($proxy.AbsoluteUri -ne $target.AbsoluteUri){[Console]::Out.Write($proxy.AbsoluteUri)}",
  ].join('; ');
  try {
    const value = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    return value ? new URL(value).toString() : null;
  } catch {
    return null;
  }
}

/**
 * Node fetch does not inherit Windows WinINET proxy settings. Relaunch once
 * with Node's native env-proxy support when the host already has a legitimate
 * system HTTPS proxy. The proxy URI remains only in the child environment and
 * is never logged or persisted.
 */
export function relaunchWithHostProxyIfNeeded(targetUrl: string): boolean {
  if (process.env[BOOTSTRAP_MARKER] === '1') return false;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? windowsSystemProxy(targetUrl);
  if (!proxy) return false;
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  const child = spawn(process.execPath, [
    '--use-env-proxy', ...process.execArgv, scriptPath, ...process.argv.slice(2),
  ], {
    env: {
      ...process.env,
      HTTPS_PROXY: proxy,
      [BOOTSTRAP_MARKER]: '1',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', (error) => {
    process.stderr.write(`network bootstrap child failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  return true;
}
