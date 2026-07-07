import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const articleSchema = new mongoose.Schema({

    photo : {
        type: String,
        required: true,
    },

    blog_title: {
        type: String,
        required: true
    },
    
    description : {
        type: String,
        required: true,
    },

    read_time: {
        type: String,
        required: true
    },

    doctorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Doctor",
        default: null,
    },

    createdBy: {
        type: String,
        enum: ["admin", "doctor"],
        default: "admin",
    },

    approvalStatus: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "approved",
    },

    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AppAdmin",
        default: null,
    },

    approvedAt: {
        type: Date,
        default: null,
    },

    rejectionReason: {
        type: String,
        default: "",
    },

}, 
{
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const Article = mongoose.model('Article', articleSchema);

export default Article;