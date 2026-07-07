import mongoose from 'mongoose';

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const deviceSchema = new mongoose.Schema({
    unique_id: {
        type: Number,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
    },
    type: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'maintenance'],
        default: 'inactive',
    },
}, {
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const Device = mongoose.model('Device', deviceSchema);

export default Device;