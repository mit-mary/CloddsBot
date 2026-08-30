import { resolve } from 'node:path';
import { assertPaperOnlyEnvironment } from '../safety/paper-only.js';
import { createShadowObserverServer } from './shadow-observer.js';

function value(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main(): Promise<void> {
  assertPaperOnlyEnvironment();
  const observer = createShadowObserverServer({
    runDir: resolve(value('run-dir')),
    host: value('host', '127.0.0.1'),
    port: Number(value('port', '4310')),
    pathPrefix: value('path-prefix', '/shadow'),
    initialTailBytes: Number(value('tail-mb', '16')) * 1024 * 1024,
  });
  const address = await observer.start();
  process.stdout.write(`${JSON.stringify({
    service: 'shadow-observer-v1',
    readOnly: true,
    runDir: observer.reader.runDir,
    ...address,
  })}\n`);
  const stop = async () => {
    await observer.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
