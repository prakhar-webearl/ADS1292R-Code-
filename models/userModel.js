import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
    const now = new Date();
    const istTime = new Date(now.getTime() + istOffset);
    return istTime;
}

const userSchema = new mongoose.Schema({
    full_name: {
        type: String,
        required: true
    },
    email : {
        type: String,
        required: true,
        unique: true,
    },

    phoneNumber : {
        type: String,
    },

    dob: {
        type: Date,
    },

    password : {
        type: String,
        required: true,
    },
    googleId: {
        type: String,
    },
    age: {
        type: Number,
    },

    gender :{
        type: String,   
        enum: ['Male', 'Female', 'Other']
    },

    weight: {
        type: Number,
    },

    height: {
        type: Number,
    },
    country: {
        type: String,
    },
    state: {
        type: String,
    },
    city: {
        type: String,
    },
    
    agree_terms_condition: {
        type: Boolean,
        default: false
    },
    
    privacy_policy: {
        type: Boolean,
        default: false
    },
     
    status: {
        type: String,
        enum: ['active', 'blocked'],
        default: 'active'
    },

    subscription: {
        planId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plan',
            default: null
        },
        purchaseId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PlanPurchase',
            default: null
        },
        status: {
            type: String,
            enum: ['inactive', 'active', 'expired', 'cancelled'],
            default: 'inactive'
        },
        startedAt: {
            type: Date,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        }
    }
}, 
{
    timestamps: {
        currentTime: () => getISTTime()
    }
});

const User = mongoose.model('User', userSchema);

export default User;