#!/usr/bin/env node
/**
 * PreToolUse hook of the data chat: Read may open files inside the policies folder only.
 * Usage (set up by src/server/agent.ts): node guard-read.mjs <allowed dir>
 * Exit 2 blocks the call and tells Claude why. Symlinks are resolved before the check.
 */
import { realpathSync } from 'fs';
import { isAbsolute, resolve, sep } from 'path';

const deny = reason => {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
};

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { deny('blocked: unreadable hook input'); }
  const target = input?.tool_input?.file_path;
  if (typeof target !== 'string' || !target) deny('blocked: no file path');

  let allowed, file;
  try { allowed = realpathSync(process.argv[2]); } catch { deny('blocked: there are no policy files'); }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  try { file = realpathSync(isAbsolute(target) ? target : resolve(cwd, target)); } catch { deny(`blocked: ${target} does not exist`); }

  if (!file.startsWith(allowed + sep)) deny('blocked: only files in the policies folder can be read');
  process.exit(0);
});
