import mongoose from "mongoose";

function getISTTime() {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    return new Date(now.getTime() + istOffset);
}

const doctorSchema = new mongoose.Schema(
    {
        full_name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            unique: true,
            sparse: true,
            lowercase: true,
            trim: true,
        },
        phoneNumber: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        password: {
            type: String,
            required: true,
        },
        specialization: {
            type: String,
            default: "",
        },
        experienceYears: {
            type: Number,
            default: null,
        },
        qualification: {
            type: String,
            default: "",
        },
        clinicAddress: {
            type: String,
            default: "",
        },
        bio: {
            type: String,
            default: "",
        },
        status: {
            type: String,
            enum: ["active", "blocked"],
            default: "active",
        },
        approvalStatus: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
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
        passwordResetOtpHash: {
            type: String,
            default: null,
        },
        passwordResetOtpExpiresAt: {
            type: Date,
            default: null,
        },
        passwordResetTokenHash: {
            type: String,
            default: null,
        },
        passwordResetTokenExpiresAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: {
            currentTime: () => getISTTime(),
        },
    },
);

const Doctor = mongoose.model("Doctor", doctorSchema);

export default Doctor;
