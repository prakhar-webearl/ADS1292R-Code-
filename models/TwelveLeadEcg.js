import mongoose from 'mongoose';

const twelveLeadEcgSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: '',
      index: true,
    },
    deviceId: {
      type: String,
      default: '',
      index: true,
    },
    sr: {
      type: Number,
      default: 250,
    },
    status: {
      type: String,
      enum: ['collecting', 'completed', 'failed', 'cancelled'],
      default: 'collecting',
    },
    completedLeads: {
      type: [String],
      default: [],
    },
    totalLeads: {
      type: Number,
      default: 0,
    },
    leads: {
      L1: { type: [Number], default: [] },
      L2: { type: [Number], default: [] },
      L3: { type: [Number], default: [] },
      aVR: { type: [Number], default: [] },
      aVL: { type: [Number], default: [] },
      aVF: { type: [Number], default: [] },
      V1: { type: [Number], default: [] },
      V2: { type: [Number], default: [] },
      V3: { type: [Number], default: [] },
      V4: { type: [Number], default: [] },
      V5: { type: [Number], default: [] },
      V6: { type: [Number], default: [] },
    },
    metrics: {
      prIntervalMs: { type: Number, default: null },
      qrsIntervalMs: { type: Number, default: null },
      qtIntervalMs: { type: Number, default: null },
      qtcIntervalMs: { type: Number, default: null },
      heartRateBpm: { type: Number, default: null },
    },
    interpretation: {
      status: { type: String, default: 'Normal Sinus Rhythm' },
      reasons: { type: [String], default: [] },
      qualityLabel: { type: String, default: 'Good' },
      qualityScore: { type: Number, default: 95 },
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

const TwelveLeadEcg = mongoose.model('TwelveLeadEcg', twelveLeadEcgSchema);

export default TwelveLeadEcg;
