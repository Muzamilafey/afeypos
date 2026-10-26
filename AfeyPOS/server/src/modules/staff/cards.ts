/**
 * Staff ID cards. Each card carries a Code 128 barcode with a random code (65 bits): the server keeps
 * its SHA-256 for sign-in lookup and an encrypted copy so the card can be reprinted. Scanning the card
 * signs the employee in, approves a supervisor action or clocks them in and out, together with their
 * PIN unless the business turns that off. Reissuing a card voids the old one.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { Counter, User } from '../../models/index.js';
import { idParam } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { base32Encode, decrypt, encrypt, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import crypto from 'node:crypto';

const router = Router();

/** EMP-0001, EMP-0002... (staff are created at head office, so no branch prefix). */
export async function nextEmployeeNo() {
  const c = await Counter.findOneAndUpdate({ key: 'employee' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `EMP-${String(c!.seq).padStart(4, '0')}`;
}

/** Card codes look like "AFE7Q2M9KX4TRB3P": a fixed prefix (so the till recognises a staff card) plus 13 base32 characters. */
export const CARD_PREFIX = 'AFE';
export const isCardCode = (code: string) => /^AFE[A-Z2-7]{13}$/.test(code.trim().toUpperCase());
const cardHash = (code: string) => sha256(`staff-card:${code.trim().toUpperCase()}`);

/** Finds the active user holding this card; throws the same error for unknown, revoked and disabled. */
export async function userByCard(code: string) {
  if (!isCardCode(code)) throw unauthorized('Card not recognised');
  const u = await User.findOne({ 'card.codeHash': cardHash(code), 'card.revokedAt': null, status: 'active' });
  if (!u) throw unauthorized('Card not recognised');
  return u;
}

/** Card plus PIN (when required): counts failures towards the same lockout as passwords. */
/** `skipPin`: the card alone is enough (supervisor approvals at the till: scanning the card approves). */
export async function authenticateCard(req: Request, code: string, pin?: string, opts: { skipPin?: boolean } = {}) {
  const u = await userByCard(code);
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked');
  const needPin = !opts.skipPin && (req.tenant!.settings?.staffLogin?.cardRequiresPin ?? true);
  if (needPin) {
    if (!pin) throw new AppError(401, 'PIN_REQUIRED', 'Enter your PIN');
    if (!u.pinHash || !(await verifyPassword(pin, u.pinHash))) {
      const failed = (u.failedLogins ?? 0) + 1;
      await User.updateOne({ _id: u._id }, { $set: { failedLogins: failed, ...(failed >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000) } : {}) } });
      throw unauthorized(u.pinHash ? 'Wrong PIN' : 'Set a PIN for this employee before using the card');
    }
  }
  return u;
}

function cardView(u: any, code: string) {
  return { code, employeeNo: u.employeeNo, name: u.name, jobTitle: u.jobTitle, roles: u.roles, photoFileId: u.photoFileId, issuedAt: u.card.issuedAt };
}

router.post('/settings/users/:id/card', requirePermission('users.manage'), async (req, res) => {
  const u = await User.findById(idParam(req.params.id));
  if (!u) throw notFound('User');
  const code = CARD_PREFIX + base32Encode(crypto.randomBytes(10)).slice(0, 13);
  if (!u.employeeNo) u.employeeNo = await nextEmployeeNo();
  const reissue = Boolean(u.card?.codeHash && !u.card.revokedAt);
  u.card = { codeHash: cardHash(code), codeEnc: encrypt(code, `card:${u._id}`), last4: code.slice(-4), issuedAt: new Date(), issuedBy: req.auth!.userId, revokedAt: undefined } as any;
  await u.save();
  await audit(req, { action: reissue ? 'staff.card_reissued' : 'staff.card_issued', entity: 'User', entityId: u._id, details: { last4: code.slice(-4) } });
  res.status(201).json({ data: cardView(u, code) });
});

/** For reprinting the current card. */
router.get('/settings/users/:id/card', requirePermission('users.manage'), async (req, res) => {
  const u = await User.findById(idParam(req.params.id)).lean();
  if (!u?.card?.codeEnc || u.card.revokedAt) throw notFound('Card');
  res.json({ data: cardView(u, decrypt(u.card.codeEnc, `card:${u._id}`)) });
});

router.delete('/settings/users/:id/card', requirePermission('users.manage'), async (req, res) => {
  const r = await User.updateOne({ _id: idParam(req.params.id), 'card.codeHash': { $type: 'string' } }, { $set: { 'card.revokedAt': new Date() }, $unset: { 'card.codeHash': 1, 'card.codeEnc': 1 } });
  if (!r.matchedCount) throw notFound('Card');
  await audit(req, { action: 'staff.card_revoked', entity: 'User', entityId: req.params.id });
  res.json({ ok: true });
});

export const staffCardRoutes = router;
