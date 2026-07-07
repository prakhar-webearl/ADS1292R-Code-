import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const PrivacyPolicySchema = new mongoose.Schema({

    title: {
        type: String,
        required: true
    },
    
    contentHtml: {
        type: String,
        required: true,
    },

    description : {
        type: String,
        required: false,
    },

}, 
{
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const PrivacyPolicy = mongoose.model('PrivacyPolicy', PrivacyPolicySchema);

export default PrivacyPolicy;