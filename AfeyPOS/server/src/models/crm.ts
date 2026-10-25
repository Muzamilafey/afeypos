import { Schema } from 'mongoose';
import { ObjectId, tenantModel } from './common.js';

/** Notes, calls, visits, complaints and follow-up tasks against a customer. */
const activitySchema = new Schema(
  {
    customerId: { type: ObjectId, required: true },
    type: { type: String, enum: ['note', 'call', 'visit', 'sms', 'email', 'whatsapp', 'complaint', 'task'], required: true },
    subject: { type: String, required: true },
    body: String,
    /** Follow-up date; open until done. */
    dueAt: Date,
    done: { type: Boolean, default: false },
    doneAt: Date,
    assignedTo: ObjectId,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
activitySchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
activitySchema.index({ tenantId: 1, done: 1, dueAt: 1 });
export const CustomerActivity = tenantModel('CustomerActivity', activitySchema);

/** SMS or email sent to a segment of customers who agreed to marketing messages. */
const campaignSchema = new Schema(
  {
    number: { type: String, required: true },
    name: { type: String, required: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    subject: String,
    message: { type: String, required: true },
    segment: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['draft', 'sent', 'cancelled'], default: 'draft' },
    recipients: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    createdBy: ObjectId,
    sentBy: ObjectId,
    sentAt: Date,
  },
  { timestamps: true },
);
campaignSchema.index({ tenantId: 1, number: 1 }, { unique: true });
export const Campaign = tenantModel('Campaign', campaignSchema);
