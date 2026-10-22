import { Schema, model, type Model, type InferSchemaType, type Types } from 'mongoose';
import { tenantPlugin } from '../db/tenantPlugin.js';

export const ObjectId = Schema.Types.ObjectId;

/** Creates a tenant-scoped model. All tenant-owned data must be defined through this helper. */
export function tenantModel<S extends Schema>(name: string, schema: S): Model<InferSchemaType<S> & { tenantId: Types.ObjectId }> {
  schema.plugin(tenantPlugin);
  return model(name, schema) as unknown as Model<InferSchemaType<S> & { tenantId: Types.ObjectId }>;
}

export const refSchema = new Schema(
  { type: { type: String }, id: { type: ObjectId }, number: { type: String } },
  { _id: false },
);
