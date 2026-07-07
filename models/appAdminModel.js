import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const appAdminSchema = new mongoose.Schema({
 
    email : {
        type: String,
        required: true,
        unique: true,
    },

    phoneNumber : {
        type: String,
        required: true,
        unique: true,
    },

    password : {
        type: String,
        required: true,
    },
    
}, {
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const AppAdmin = mongoose.model('AppAdmin', appAdminSchema);

export default AppAdmin;