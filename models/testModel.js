import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const testSchema = new mongoose.Schema({

    photo: {
        type: String,
        required: true
    },

    name: {
        type: String,
        required: true
    },
    
    description_name: {
        type: String,
        required: true
    },

    description: {
        type: String,
        required: true
    },

    question_title: {
        type: String,
        required: true
    },

    answer: [
        {
            point: {
            type: String,
            required: true
          },
        },
    ],
}, 
{
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const Test = mongoose.model('Test', testSchema);

export default Test;