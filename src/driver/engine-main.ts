import { text } from 'node:stream/consumers';
import { runEngine, type EngineConfig } from './engine.ts';

const stamp = () => `${new Date().toISOString()} [engine ${String(process.pid)}]`;
try {
  const config = JSON.parse(await text(process.stdin)) as EngineConfig;
  const reason = await runEngine(config);
  process.stderr.write(`${stamp()} exit: ${reason}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`${stamp()} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
