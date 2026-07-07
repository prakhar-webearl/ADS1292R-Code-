import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const userAddSchema = new mongoose.Schema({
    full_name: { 
        type: String, 
        required: true 
    },

    email: {
        type:String,
    },

    relation: { 
        type: String, 
        required: true
    },

    age: { 
        type: Number, 
        required: true 
    },

    gender: { 
        type: String, 
        enum: ['male', 'female', 'other'], 
        required: true 
    },

    weight: { 
        type: Number, 
        required: true 
    },

    height: { 
        type: Number, 
        required: true 
    },

    createdBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    }

}, {
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const AddedUser = mongoose.model('AddedUser', userAddSchema);

export default AddedUser;