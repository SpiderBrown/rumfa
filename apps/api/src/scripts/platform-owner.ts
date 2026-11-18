// Creates a Rumfa Console owner and prints a one-time link to set their password (valid 3 days). Run once to get
// the first owner in; after that, owners invite other staff from the console. Running it again for the same email
// prints a fresh link (for example if the owner lost their password and no other owner can reset it).
// Usage: npm run platform:owner -- --email you@example.com --name "Your Name" [--console https://console.rumfa.ng]
import configuration from '../config/configuration';
import { keyedHash, randomToken } from '../auth/crypto';
import { arg, log, withDb } from './run';

void withDb(async (q) => {
  const email = arg('--email')?.trim().toLowerCase();
  const name = arg('--name')?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) throw new Error('Usage: --email <email> --name "<full name>"');
  const consoleUrl = (arg('--console') ?? process.env.CONSOLE_URL ?? 'http://localhost:4400').replace(/\/+$/, '');
  const secret = configuration().auth.jwtSecret;
  const [s] = await q(
    `insert into public.platform_staff (email, full_name, role) values ($1, $2, 'owner')
     on conflict (email) do update set role = 'owner', status = case when platform_staff.status = 'suspended' then 'active' else platform_staff.status end
     returning id`, [email, name]);
  const token = randomToken();
  await q(`insert into public.platform_invites (staff_id, token_hash, expires_at) values ($1, $2, now() + interval '3 days')`,
    [s.id, keyedHash(secret, `pinvite:${token}`)]);
  await q(`insert into public.platform_audit (action, target_type, target_id, details) values ('staff.owner_link', 'staff', $1, $2)`,
    [s.id, JSON.stringify({ email, by: 'command line' })]);
  log('console', `${email} is a Rumfa owner. Open this link within 3 days to set the password:`);
  console.log(`\n  ${consoleUrl}/invite?token=${token}\n`);
});
