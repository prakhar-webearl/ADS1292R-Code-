import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const helpSchema = new mongoose.Schema({

    question : {
        type: String,
        required: true
    },
    
    answer : {
        type: String,
        required: true,
    },

}, 
{
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const Help = mongoose.model('Help', helpSchema);

export default Help;