import mongoose from 'mongoose';

const monitorEcgDataSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: '',
      index: true,
    },
    deviceId: {
      type: String,
      required: [true, 'Please provide a device ID'],
      index: true,
    },
    fromSeq: {
      type: Number,
      required: true,
    },
    toSeq: {
      type: Number,
      required: true,
    },
    sr: {
      type: Number,
      required: true,
    },
    lo: {
      type: Boolean,
      required: true,
    },
    data: {
      type: [Number],
      required: true,
    },
    abnormalities: [
      {
        timestamp: Date,
        abnormalityName: String,
        severity: String,
        confidence: Number,
        bpm: Number,
        data: [Number],
        additionalData: mongoose.Schema.Types.Mixed,
        sourceDate: String,
      },
    ],
    sampleCount: {
      type: Number,
      required: true,
      default: 0,
    },
    durationSeconds: {
      type: Number,
      required: true,
      default: 12,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    endedAt: {
      type: Date,
      required: true,
    },
    monitor: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

const MonitorEcgData = mongoose.model('MonitorEcgData', monitorEcgDataSchema);

export default MonitorEcgData;
