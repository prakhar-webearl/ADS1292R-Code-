import mongoose from 'mongoose';

const ecgDataSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: '',
      index: true,
    },
    deviceId: {
      type: String,
      required: [true, 'Please provide a device ID'],
    },
    seq: {
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
    device_result: {
      type: String,
      default: '',
    },
    ai_result: {
      prediction: String,
      confidence: Number,
      alert_level: String,
      detection_method: String,
      heart_rate: Number,
      rr_interval: Number,
      rr_variation: Number,
      rmssd: Number,
      not_normal_reasons: [String],
      top3: [
        {
          condition: String,
          confidence: Number,
        },
      ],
      timestamp: Date,
      source_time: Date,
    },
  },
  {
    timestamps: true,
  }
);

const EcgData = mongoose.model('EcgData', ecgDataSchema);

export default EcgData;
