import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import Doctor from "../models/doctorModel.js";
import Article from "../models/articlesModel.js";
import { uploadImageToImageKit } from "../services/imagekitService.js";

const OTP_EXPIRY_MINUTES = 10;
const RESET_TOKEN_EXPIRY_MINUTES = 15;

const generateDoctorToken = (doctorId) => jwt.sign(
    { id: doctorId, role: "doctor" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
);

const isBcryptHash = (value) => typeof value === "string" && /^\$2[aby]?\$/.test(value);

const hashValue = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const doctorPublicFields = (doctor) => ({
    _id: doctor._id,
    full_name: doctor.full_name,
    email: doctor.email,
    phoneNumber: doctor.phoneNumber,
    specialization: doctor.specialization,
    experienceYears: doctor.experienceYears,
    qualification: doctor.qualification,
    clinicAddress: doctor.clinicAddress,
    bio: doctor.bio,
    status: doctor.status,
    approvalStatus: doctor.approvalStatus,
    approvedAt: doctor.approvedAt,
    rejectionReason: doctor.rejectionReason,
    createdAt: doctor.createdAt,
    updatedAt: doctor.updatedAt,
});

const buildPagination = (value, defaultValue) => {
    const parsedValue = Number.parseInt(value, 10);
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
};

const buildSearchQuery = (search) => {
    if (!search) {
        return null;
    }

    const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escapedSearch) {
        return null;
    }

    return {
        $or: [
            { full_name: { $regex: escapedSearch, $options: "i" } },
            { email: { $regex: escapedSearch, $options: "i" } },
            { phoneNumber: { $regex: escapedSearch, $options: "i" } },
            { specialization: { $regex: escapedSearch, $options: "i" } },
            { qualification: { $regex: escapedSearch, $options: "i" } },
            { clinicAddress: { $regex: escapedSearch, $options: "i" } },
        ],
    };
};

const buildBlogSearchQuery = (search) => {
    if (!search) {
        return null;
    }

    const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escapedSearch) {
        return null;
    }

    return {
        $or: [
            { blog_title: { $regex: escapedSearch, $options: "i" } },
            { description: { $regex: escapedSearch, $options: "i" } },
            { read_time: { $regex: escapedSearch, $options: "i" } },
        ],
    };
};

const registerDoctor = async (req, res) => {
    try {
        const {
            full_name,
            email,
            phoneNumber,
            password,
            specialization,
            experienceYears,
            qualification,
            clinicAddress,
            bio,
        } = req.body;

        if (!full_name || !phoneNumber || !password) {
            return res.status(400).json({
                success: false,
                message: "full_name, phoneNumber and password are required",
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters long",
            });
        }

        const normalizedEmail = email ? String(email).toLowerCase().trim() : undefined;
        const normalizedPhone = String(phoneNumber).trim();

        const emailQuery = normalizedEmail ? [{ email: normalizedEmail }] : [];
        const existingDoctor = await Doctor.findOne({
            $or: [{ phoneNumber: normalizedPhone }, ...emailQuery],
        });

        if (existingDoctor) {
            return res.status(400).json({
                success: false,
                message: "Doctor already exists with this phone number or email",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const doctor = await Doctor.create({
            full_name,
            email: normalizedEmail,
            phoneNumber: normalizedPhone,
            password: hashedPassword,
            specialization,
            experienceYears,
            qualification,
            clinicAddress,
            bio,
        });

        return res.status(201).json({
            success: true,
            message: "Doctor registered successfully. Waiting for admin approval.",
            doctor: doctorPublicFields(doctor),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error registering doctor",
            error: error.message,
        });
    }
};

const loginDoctor = async (req, res) => {
    try {
        const { phoneNumber, password } = req.body || {};

        if (!phoneNumber || !password) {
            return res.status(400).json({
                success: false,
                message: "phoneNumber and password are required",
            });
        }

        const normalizedPhone = String(phoneNumber).trim();

        const doctor = await Doctor.findOne({ phoneNumber: normalizedPhone });

        if (!doctor) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials",
            });
        }

        const isMatch = isBcryptHash(doctor.password)
            ? await bcrypt.compare(password, doctor.password)
            : password === doctor.password;

        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials",
            });
        }

        if (doctor.approvalStatus !== "approved") {
            return res.status(403).json({
                success: false,
                message: "Doctor account is not approved by admin yet",
                approvalStatus: doctor.approvalStatus,
                rejectionReason: doctor.rejectionReason || null,
            });
        }

        if (doctor.status === "blocked") {
            return res.status(403).json({
                success: false,
                message: "Doctor account is blocked",
            });
        }

        const token = generateDoctorToken(doctor._id);

        return res.status(200).json({
            success: true,
            message: "Doctor login successful",
            token,
            doctor: doctorPublicFields(doctor),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error logging in doctor",
            error: error.message,
        });
    }
};

const getDoctorProfile = async (req, res) => {
    return res.status(200).json({
        success: true,
        doctor: doctorPublicFields(req.doctor),
    });
};

const updateDoctorProfile = async (req, res) => {
    try {
        const {
            full_name,
            email,
            phoneNumber,
            specialization,
            experienceYears,
            qualification,
            clinicAddress,
            bio,
        } = req.body;

        const doctor = await Doctor.findById(req.doctor._id);

        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        if (email !== undefined) {
            const normalizedEmail = email ? String(email).toLowerCase().trim() : null;
            if (normalizedEmail) {
                const existingByEmail = await Doctor.findOne({
                    email: normalizedEmail,
                    _id: { $ne: doctor._id },
                });
                if (existingByEmail) {
                    return res.status(400).json({
                        success: false,
                        message: "Email is already used by another doctor",
                    });
                }
                doctor.email = normalizedEmail;
            } else {
                doctor.email = undefined;
            }
        }

        if (phoneNumber !== undefined) {
            const normalizedPhone = String(phoneNumber).trim();
            const existingByPhone = await Doctor.findOne({
                phoneNumber: normalizedPhone,
                _id: { $ne: doctor._id },
            });

            if (existingByPhone) {
                return res.status(400).json({
                    success: false,
                    message: "Phone number is already used by another doctor",
                });
            }

            doctor.phoneNumber = normalizedPhone;
        }

        if (full_name !== undefined) doctor.full_name = full_name;
        if (specialization !== undefined) doctor.specialization = specialization;
        if (experienceYears !== undefined) doctor.experienceYears = experienceYears;
        if (qualification !== undefined) doctor.qualification = qualification;
        if (clinicAddress !== undefined) doctor.clinicAddress = clinicAddress;
        if (bio !== undefined) doctor.bio = bio;

        await doctor.save();

        return res.status(200).json({
            success: true,
            message: "Doctor profile updated successfully",
            doctor: doctorPublicFields(doctor),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating doctor profile",
            error: error.message,
        });
    }
};

const doctorChangePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "oldPassword and newPassword are required",
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "newPassword must be at least 6 characters long",
            });
        }

        const doctor = await Doctor.findById(req.doctor._id);
        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        const isMatch = isBcryptHash(doctor.password)
            ? await bcrypt.compare(oldPassword, doctor.password)
            : oldPassword === doctor.password;

        if (!isMatch) {
            return res.status(400).json({
                success: false,
                message: "Old password is incorrect",
            });
        }

        doctor.password = await bcrypt.hash(newPassword, 10);
        await doctor.save();

        return res.status(200).json({
            success: true,
            message: "Password changed successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error changing password",
            error: error.message,
        });
    }
};

const requestDoctorForgotPasswordOtp = async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: "phoneNumber is required",
            });
        }

        const doctor = await Doctor.findOne({ phoneNumber: String(phoneNumber).trim() });

        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found with this phone number",
            });
        }

        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const otpHash = hashValue(otp);
        const expiryDate = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        doctor.passwordResetOtpHash = otpHash;
        doctor.passwordResetOtpExpiresAt = expiryDate;
        doctor.passwordResetTokenHash = null;
        doctor.passwordResetTokenExpiresAt = null;
        await doctor.save();

        const responsePayload = {
            success: true,
            message: "OTP sent successfully",
            phoneNumber: doctor.phoneNumber,
            expiresAt: expiryDate,
            otp,
        };

        return res.status(200).json(responsePayload);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error generating OTP",
            error: error.message,
        });
    }
};

const verifyDoctorForgotPasswordOtp = async (req, res) => {
    try {
        const { phoneNumber, otp } = req.body;

        if (!phoneNumber || !otp) {
            return res.status(400).json({
                success: false,
                message: "phoneNumber and otp are required",
            });
        }

        const doctor = await Doctor.findOne({ phoneNumber: String(phoneNumber).trim() });
        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        if (!doctor.passwordResetOtpHash || !doctor.passwordResetOtpExpiresAt) {
            return res.status(400).json({
                success: false,
                message: "No OTP request found. Please request OTP again.",
            });
        }

        if (new Date(doctor.passwordResetOtpExpiresAt).getTime() < Date.now()) {
            return res.status(400).json({
                success: false,
                message: "OTP expired. Please request OTP again.",
            });
        }

        const incomingOtpHash = hashValue(otp);
        if (incomingOtpHash !== doctor.passwordResetOtpHash) {
            return res.status(400).json({
                success: false,
                message: "Invalid OTP",
            });
        }

        const resetToken = crypto.randomBytes(24).toString("hex");
        const resetTokenHash = hashValue(resetToken);
        const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

        doctor.passwordResetOtpHash = null;
        doctor.passwordResetOtpExpiresAt = null;
        doctor.passwordResetTokenHash = resetTokenHash;
        doctor.passwordResetTokenExpiresAt = resetTokenExpiry;
        await doctor.save();

        return res.status(200).json({
            success: true,
            message: "OTP verified successfully",
            resetToken,
            resetTokenExpiresAt: resetTokenExpiry,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error verifying OTP",
            error: error.message,
        });
    }
};

const resetDoctorPasswordWithOtp = async (req, res) => {
    try {
        const { phoneNumber, resetToken, newPassword } = req.body;

        if (!phoneNumber || !resetToken || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "phoneNumber, resetToken and newPassword are required",
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "newPassword must be at least 6 characters long",
            });
        }

        const doctor = await Doctor.findOne({ phoneNumber: String(phoneNumber).trim() });
        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        if (!doctor.passwordResetTokenHash || !doctor.passwordResetTokenExpiresAt) {
            return res.status(400).json({
                success: false,
                message: "Invalid reset session. Verify OTP again.",
            });
        }

        if (new Date(doctor.passwordResetTokenExpiresAt).getTime() < Date.now()) {
            return res.status(400).json({
                success: false,
                message: "Reset session expired. Verify OTP again.",
            });
        }

        const incomingTokenHash = hashValue(resetToken);
        if (incomingTokenHash !== doctor.passwordResetTokenHash) {
            return res.status(400).json({
                success: false,
                message: "Invalid reset token",
            });
        }

        doctor.password = await bcrypt.hash(newPassword, 10);
        doctor.passwordResetTokenHash = null;
        doctor.passwordResetTokenExpiresAt = null;
        await doctor.save();

        return res.status(200).json({
            success: true,
            message: "Password reset successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error resetting password",
            error: error.message,
        });
    }
};

const getPendingDoctors = async (req, res) => {
    try {
        const doctors = await Doctor.find({ approvalStatus: "pending" })
            .select("-password -passwordResetOtpHash -passwordResetTokenHash")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            total: doctors.length,
            doctors,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching pending doctors",
            error: error.message,
        });
    }
};

const getAdminDoctors = async (req, res) => {
    try {
        const page = buildPagination(req.query.page, 1);
        const limit = buildPagination(req.query.limit, 10);
        const skip = (page - 1) * limit;
        const { status, approvalStatus, specialization, search } = req.query;

        const query = {};

        if (status) {
            query.status = status;
        }

        if (approvalStatus) {
            query.approvalStatus = approvalStatus;
        }

        if (specialization) {
            query.specialization = { $regex: String(specialization).trim(), $options: "i" };
        }

        const searchQuery = buildSearchQuery(search);
        if (searchQuery) {
            Object.assign(query, searchQuery);
        }

        const [totalDoctors, doctors] = await Promise.all([
            Doctor.countDocuments(query),
            Doctor.find(query)
                .select("-password -passwordResetOtpHash -passwordResetTokenHash")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
        ]);

        return res.status(200).json({
            success: true,
            page,
            limit,
            totalDoctors,
            totalPages: Math.ceil(totalDoctors / limit),
            doctors,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching doctors",
            error: error.message,
        });
    }
};

const getAdminDoctorById = async (req, res) => {
    try {
        const { id } = req.params;

        const doctor = await Doctor.findById(id)
            .select("-password -passwordResetOtpHash -passwordResetTokenHash")
            .lean();

        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        const blogs = await Article.find({ doctorId: doctor._id })
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            doctor: {
                ...doctor,
                blogs,
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching doctor profile",
            error: error.message,
        });
    }
};

const updateDoctorStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!["active", "blocked"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "status must be active or blocked",
            });
        }

        const doctor = await Doctor.findById(id);

        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        doctor.status = status;
        await doctor.save();

        return res.status(200).json({
            success: true,
            message: "Doctor status updated successfully",
            doctor: doctorPublicFields(doctor),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating doctor status",
            error: error.message,
        });
    }
};

const updateDoctorApprovalStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { approvalStatus, rejectionReason } = req.body;

        if (!["approved", "rejected"].includes(approvalStatus)) {
            return res.status(400).json({
                success: false,
                message: "approvalStatus must be approved or rejected",
            });
        }

        const doctor = await Doctor.findById(id);
        if (!doctor) {
            return res.status(404).json({
                success: false,
                message: "Doctor not found",
            });
        }

        doctor.approvalStatus = approvalStatus;
        doctor.approvedBy = req.user?._id || null;
        doctor.approvedAt = new Date();
        doctor.rejectionReason = approvalStatus === "rejected"
            ? (rejectionReason || "")
            : "";

        await doctor.save();

        return res.status(200).json({
            success: true,
            message: `Doctor ${approvalStatus} successfully`,
            doctor: doctorPublicFields(doctor),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating doctor approval",
            error: error.message,
        });
    }
};

const createDoctorBlog = async (req, res) => {
    try {
        const { blog_title, description, read_time } = req.body;

        if (!blog_title || !description || !read_time) {
            return res.status(400).json({
                success: false,
                message: "blog_title, description and read_time are required",
            });
        }

        if (!req.file?.buffer) {
            return res.status(400).json({
                success: false,
                message: "photo is required",
            });
        }

        const photo = await uploadImageToImageKit({
            fileBuffer: req.file.buffer,
            fileName: req.file.originalname,
            folder: "/articles",
        });

        const blog = await Article.create({
            doctorId: req.doctor._id,
            blog_title,
            description,
            read_time,
            photo,
            createdBy: "doctor",
            approvalStatus: "pending",
            approvedBy: null,
            approvedAt: null,
            rejectionReason: "",
        });

        return res.status(201).json({
            success: true,
            message: "Blog created successfully and sent for admin approval",
            blog,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error creating doctor blog",
            error: error.message,
        });
    }
};

const updateDoctorBlog = async (req, res) => {
    try {
        const { id } = req.params;
        const { blog_title, description, read_time } = req.body;

        const blog = await Article.findOne({
            _id: id,
            doctorId: req.doctor._id,
            createdBy: "doctor",
        });

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        if (blog_title !== undefined) blog.blog_title = blog_title;
        if (description !== undefined) blog.description = description;
        if (read_time !== undefined) blog.read_time = read_time;

        if (req.file?.buffer) {
            const uploadedPhoto = await uploadImageToImageKit({
                fileBuffer: req.file.buffer,
                fileName: req.file.originalname,
                folder: "/articles",
            });
            blog.photo = uploadedPhoto;
        }

        // Any doctor edit requires fresh admin review.
        blog.approvalStatus = "pending";
        blog.approvedBy = null;
        blog.approvedAt = null;
        blog.rejectionReason = "";

        await blog.save();

        return res.status(200).json({
            success: true,
            message: "Blog updated successfully and sent for admin approval",
            blog,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating doctor blog",
            error: error.message,
        });
    }
};

const deleteDoctorBlog = async (req, res) => {
    try {
        const { id } = req.params;

        const deletedBlog = await Article.findOneAndDelete({
            _id: id,
            doctorId: req.doctor._id,
            createdBy: "doctor",
        });

        if (!deletedBlog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Blog deleted successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error deleting doctor blog",
            error: error.message,
        });
    }
};

const getDoctorOwnBlogs = async (req, res) => {
    try {
        const blogs = await Article.find({ doctorId: req.doctor._id })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            total: blogs.length,
            blogs,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching doctor blogs",
            error: error.message,
        });
    }
};

const getApprovedDoctorBlogs = async (req, res) => {
    try {
        const blogs = await Article.find({
            createdBy: "doctor",
            approvalStatus: "approved",
        })
            .populate("doctorId", "full_name specialization qualification")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            total: blogs.length,
            blogs,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching approved doctor blogs",
            error: error.message,
        });
    }
};

const getDoctorBlogById = async (req, res) => {
    try {
        const { id } = req.params;
        const blog = await Article.findOne({
            _id: id,
            createdBy: "doctor",
        })
            .populate("doctorId", "full_name specialization qualification");

        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        if (blog.approvalStatus !== "approved") {
            return res.status(403).json({
                success: false,
                message: "Blog is not approved yet",
            });
        }

        return res.status(200).json({
            success: true,
            blog,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching blog",
            error: error.message,
        });
    }
};

const getPendingDoctorBlogs = async (req, res) => {
    try {
        const blogs = await Article.find({
            createdBy: "doctor",
            approvalStatus: "pending",
        })
            .populate("doctorId", "full_name phoneNumber email")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            total: blogs.length,
            blogs,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching pending blogs",
            error: error.message,
        });
    }
};

const getAdminDoctorBlogs = async (req, res) => {
    try {
        const page = buildPagination(req.query.page, 1);
        const limit = buildPagination(req.query.limit, 10);
        const skip = (page - 1) * limit;
        const { approvalStatus, search, doctorId } = req.query;

        const query = { createdBy: "doctor" };

        if (approvalStatus) {
            query.approvalStatus = approvalStatus;
        }

        if (doctorId) {
            query.doctorId = doctorId;
        }

        const searchQuery = buildBlogSearchQuery(search);
        if (searchQuery) {
            Object.assign(query, searchQuery);
        }

        const [totalBlogs, blogs] = await Promise.all([
            Article.countDocuments(query),
            Article.find(query)
                .populate("doctorId", "full_name phoneNumber email specialization qualification status approvalStatus")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
        ]);

        return res.status(200).json({
            success: true,
            page,
            limit,
            totalBlogs,
            totalPages: Math.ceil(totalBlogs / limit),
            blogs,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching doctor blogs",
            error: error.message,
        });
    }
};

const updateDoctorBlogApprovalStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { approvalStatus, rejectionReason } = req.body;

        if (!["approved", "rejected"].includes(approvalStatus)) {
            return res.status(400).json({
                success: false,
                message: "approvalStatus must be approved or rejected",
            });
        }

        const blog = await Article.findOne({
            _id: id,
            createdBy: "doctor",
        });
        if (!blog) {
            return res.status(404).json({
                success: false,
                message: "Blog not found",
            });
        }

        blog.approvalStatus = approvalStatus;
        blog.approvedBy = req.user?._id || null;
        blog.approvedAt = new Date();
        blog.rejectionReason = approvalStatus === "rejected"
            ? (rejectionReason || "")
            : "";

        await blog.save();

        return res.status(200).json({
            success: true,
            message: `Blog ${approvalStatus} successfully`,
            blog,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating blog approval",
            error: error.message,
        });
    }
};

const getActiveApprovedDoctors = async (req, res) => {
    try {
        const page = buildPagination(req.query.page, 1);
        const limit = buildPagination(req.query.limit, 10);
        const skip = (page - 1) * limit;
        const { specialization, search } = req.query;

        const query = {
            status: "active",
            approvalStatus: "approved",
        };

        if (specialization) {
            query.specialization = { $regex: String(specialization).trim(), $options: "i" };
        }

        const searchQuery = buildSearchQuery(search);
        if (searchQuery) {
            Object.assign(query, searchQuery);
        }

        const [totalDoctors, doctors] = await Promise.all([
            Doctor.countDocuments(query),
            Doctor.find(query)
                .select("-password -passwordResetOtpHash -passwordResetTokenHash")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
        ]);

        return res.status(200).json({
            success: true,
            message: "Active approved doctors fetched successfully",
            page,
            limit,
            totalDoctors,
            totalPages: Math.ceil(totalDoctors / limit),
            doctors,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error fetching active approved doctors",
            error: error.message,
        });
    }
};

export {
    registerDoctor,
    loginDoctor,
    getDoctorProfile,
    updateDoctorProfile,
    doctorChangePassword,
    requestDoctorForgotPasswordOtp,
    verifyDoctorForgotPasswordOtp,
    resetDoctorPasswordWithOtp,
    getPendingDoctors,
    getAdminDoctors,
    getAdminDoctorById,
    updateDoctorStatus,
    updateDoctorApprovalStatus,
    createDoctorBlog,
    updateDoctorBlog,
    deleteDoctorBlog,
    getDoctorOwnBlogs,
    getApprovedDoctorBlogs,
    getDoctorBlogById,
    getPendingDoctorBlogs,
    getAdminDoctorBlogs,
    updateDoctorBlogApprovalStatus,
    getActiveApprovedDoctors,
};
