import { spawn } from 'child_process';

/**
 * The user's own Claude Code (`claude -p`, their subscription) with structured output: no settings, hooks, MCP servers
 * or session files, and only the tools named (none by default). Shared by report extraction and the merchant categorizer.
 */

export function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // the user's Claude subscription login, not an API key that may be set for other tools
  delete env.ANTHROPIC_API_KEY;
  // the API may itself run inside a Claude Code session
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export interface ClaudeCall {
  /** working directory: a temp dir; with `tools`, the only directory they may touch */
  cwd: string;
  prompt: string;
  model: string;
  schema: unknown;
  /** built-in tools allowed (e.g. ['Read']); none when empty */
  tools?: string[];
  timeoutMs?: number;
}

/** Run `claude -p` and resolve with its structured output. */
export function runClaude({ cwd, prompt, model, schema, tools = [], timeoutMs = 10 * 60_000 }: ClaudeCall): Promise<unknown> {
  const toolArgs = tools.length
    ? ['--tools', tools.join(','), '--allowedTools', ...tools, '--add-dir', cwd]
    : ['--tools', ''];
  const args = [
    '-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    ...toolArgs,
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', e => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Claude Code (claude) is not installed or not on PATH') : e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      let result: Record<string, any> | null = null;
      try { result = JSON.parse(out); } catch { /* reported below */ }
      if (!result || result.is_error || code !== 0) {
        return reject(new Error(String(result?.result ?? result?.subtype ?? (err.trim().slice(-600) || `claude exited with code ${code}`))));
      }
      if (result.structured_output == null) return reject(new Error('claude returned no structured output'));
      resolve(result.structured_output);
    });
    child.stdin.end(prompt);
  });
}
