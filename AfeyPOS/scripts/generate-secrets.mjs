// Prints fresh values for JWT_ACCESS_SECRET and ENCRYPTION_KEY.
import crypto from 'node:crypto';
console.log(`JWT_ACCESS_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
