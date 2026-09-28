// Runs one Claude turn in a process of its own, as a restarted Pero would:
// takes a runtime request as JSON in argv[2] and prints each event, then
// `{"type":"end"}` or `{"type":"error",…}`, one JSON line each.
import { ClaudeRuntime } from '../../dist/runtimes/claude/claude-runtime.js';

const request = JSON.parse(process.argv[2]);
const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
try {
  for await (const event of new ClaudeRuntime().execute({
    ...request,
    signal: new AbortController().signal,
  })) {
    print(event);
  }
  print({ type: 'end' });
} catch (error) {
  print({ type: 'error', kind: error.kind, message: error.message });
}
