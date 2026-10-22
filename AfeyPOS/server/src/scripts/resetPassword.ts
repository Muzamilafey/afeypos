// Local installations: reset a user's password from the server console.
// Usage: npm run reset-password -w @afeypos/server -- <email> <newPassword>
import { withDb } from './cli.js';
import { Tenant, User } from '../models/index.js';
import { runInTenant } from '../lib/context.js';
import { hashPassword } from '../lib/crypto.js';
import { passwordSchema } from '../modules/tenants/provisioning.js';
import { revokeAllSessions } from '../modules/auth/service.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: reset-password <email> <newPassword>');
  process.exit(1);
}
await withDb(async () => {
  passwordSchema.parse(password);
  const tenant = await Tenant.findOne().sort({ createdAt: 1 }).lean();
  if (!tenant) throw new Error('No business is set up yet');
  await runInTenant(tenant._id, async () => {
    const u = await User.findOne({ email: email.toLowerCase() });
    if (!u) throw new Error(`No user ${email}`);
    u.passwordHash = await hashPassword(password);
    u.failedLogins = 0;
    u.lockedUntil = undefined;
    u.status = 'active';
    await u.save();
    await revokeAllSessions(u._id);
  });
  console.log(`Password reset for ${email}. All their sessions were signed out.`);
});
