/**
 * One-time two-factor enrollment, so a bank that texts a code on every login scrapes unattended:
 *   npm run link -- onezero
 * One Zero sends an SMS to `credentials.phoneNumber`; the code is traded for the ~10-year idToken, saved as
 * `credentials.idToken` in accounts.json (never printed). The dashboard's Integrations page does the same.
 */
import * as readline from 'readline/promises';
import { ACCOUNTS_FILE } from './config.js';
import { LINKABLE, startLink } from './integrations/link.js';

async function main() {
  const arg = (process.argv[2] ?? '').toLowerCase();
  const companyId = LINKABLE[arg];
  if (!companyId) throw new Error(`usage: npm run link -- onezero   (linkable: ${Object.keys(LINKABLE).join(', ')})`);
  const session = await startLink(companyId, ACCOUNTS_FILE);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('\n🔐 Code texted to your phone: ')).trim();
  rl.close();
  await session.finish(code);
  console.log(`✅ Linked. The 10-year idToken is saved in ${ACCOUNTS_FILE}; ${companyId} now scrapes without a code.`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
