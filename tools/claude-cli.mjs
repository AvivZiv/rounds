// Runs Claude through the Claude Code CLI (`claude -p`) so generation uses the owner's
// Claude subscription instead of an API key. Requires `claude` on PATH and a login
// (`claude` once, interactively).
import { execFile } from 'node:child_process';
import { SYSTEM, parseJSON } from './tree-prompt.mjs';

// Sonnet 5.5: same node quality as Opus in testing at a third of the latency (7-9 s vs 25 s per call).
const MODEL = process.env.ROUNDS_MODEL || 'claude-sonnet-5-5';

export function askClaude(prompt, { model = MODEL, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1', '--model', model,
      '--system-prompt', SYSTEM, '--tools', '', '--no-session-persistence'];
    // Strip the variables that mark a nested Claude Code session, so the CLI runs standalone.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    execFile('claude', args, { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude failed: ${err.message} ${String(stderr).slice(0, 300)}`));
      let out;
      try { out = JSON.parse(stdout); } catch { return reject(new Error('claude returned non-JSON: ' + String(stdout).slice(0, 200))); }
      if (out.is_error || out.subtype === 'error') return reject(new Error('claude error: ' + (out.result || out.error || out.subtype)));
      try { resolve({ data: parseJSON(out.result), usage: out.usage, model: out.modelUsage ? Object.keys(out.modelUsage)[0] : model, ms: out.duration_api_ms }); }
      catch (e) { reject(new Error(`unparseable reply: ${e.message}: ${String(out.result).slice(0, 200)}`)); }
    });
  });
}
