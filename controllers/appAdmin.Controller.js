import mongoose from 'mongoose';
import AppAdmin from '../models/appAdminModel.js';
import User from '../models/userModel.js';
import AddedUser from '../models/userAddModel.js';
import PlanPurchase from '../models/planPurchaseModel.js';
import Consultancy from '../models/consultancyModel.js';
import MonitorEcgData from '../models/MonitorEcgData.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const generateToken = (userId) => {
    return jwt.sign({ id: userId }, process.env.JWT_ADMIN_SECRET, {
        expiresIn: '1d',
    });
};

const toPlainObject = (document) => {
    if (!document) {
        return null;
    }

    return document.toObject ? document.toObject() : document;
};

const toIsoDate = (value) => {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const getDaysDiff = (startDate, endDate) => {
    if (!startDate || !endDate) {
        return null;
    }

    const diffMs = endDate.getTime() - startDate.getTime();
    return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
};

const addPurchaseValidityInfo = (purchase) => {
    const purchaseObj = toPlainObject(purchase);

    if (!purchaseObj) {
        return purchaseObj;
    }

    const now = new Date();
    const purchasedAt =
        toIsoDate(purchaseObj.startsAt) ||
        toIsoDate(purchaseObj.paymentVerifiedAt) ||
        toIsoDate(purchaseObj.createdAt);
    const expiresAt = toIsoDate(purchaseObj.expiresAt);
    const billingCycle = purchaseObj?.planSnapshot?.billingCycle || purchaseObj?.planId?.billingCycle || null;
    const isLifetime = !expiresAt && billingCycle === 'lifetime';

    purchaseObj.validity = {
        purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        validDays: expiresAt && purchasedAt ? getDaysDiff(purchasedAt, expiresAt) : null,
        remainingDays: expiresAt ? getDaysDiff(now, expiresAt) : null,
        isLifetime,
        isExpired: expiresAt ? now.getTime() > expiresAt.getTime() : false,
    };

    return purchaseObj;
};

const buildReportSummary = (reports) => ({
    total: reports.length,
    latestAt: reports.length > 0 ? reports[0].createdAt || null : null,
});

const groupReportsByUserId = (reports) => reports.reduce((accumulator, report) => {
    const key = String(report.userId);

    if (!accumulator[key]) {
        accumulator[key] = [];
    }

    accumulator[key].push(report);
    return accumulator;
}, {});

const sanitizeMonitorReport = (report) => {
    const plainReport = toPlainObject(report);

    if (!plainReport) {
        return plainReport;
    }

    const { abnormalities, ...reportWithoutAbnormalities } = plainReport;
    return reportWithoutAbnormalities;
};

const buildUserDetailsPayload = async (userId) => {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return {
            status: 400,
            body: {
                success: false,
                message: 'Valid user id is required',
            },
        };
    }

    const mainUser = await User.findById(userId).select('-password').lean();

    if (!mainUser) {
        return {
            status: 404,
            body: {
                success: false,
                message: 'Main user not found',
            },
        };
    }

    const familyMembers = await AddedUser.find({ createdBy: mainUser._id }).lean();
    const allUserIds = [String(mainUser._id), ...familyMembers.map((member) => String(member._id))];

    const [monitorReports, purchases, currentPurchase, consultancies] = await Promise.all([
        MonitorEcgData.find({ userId: { $in: allUserIds } }).sort({ createdAt: -1 }).lean(),
        PlanPurchase.find({ userId: mainUser._id })
            .populate('planId', 'title planType iconType price currency billingCycle features isActive')
            .sort({ createdAt: -1 }),
        PlanPurchase.findOne({
            userId: mainUser._id,
            isCurrent: true,
            purchaseStatus: { $in: ['pending', 'active'] },
        })
            .populate('planId', 'title planType iconType price currency billingCycle features isActive')
            .sort({ createdAt: -1 }),
        Consultancy.find({ userId: mainUser._id }).sort({ createdAt: -1 }).lean(),
    ]);

    const mainUserKey = String(mainUser._id);
    const memberMetaByUserId = familyMembers.reduce((accumulator, member) => {
        const key = String(member._id);

        accumulator[key] = {
            memberId: key,
            full_name: member.full_name || null,
            relation: member.relation || null,
            isMainUser: false,
        };

        return accumulator;
    }, {
        [mainUserKey]: {
            memberId: mainUserKey,
            full_name: mainUser.full_name || null,
            relation: 'self',
            isMainUser: true,
        },
    });

    const addMemberDetailsToReport = (report) => {
        const key = String(report.userId);

        return {
            ...report,
            member: memberMetaByUserId[key] || {
                memberId: key,
                full_name: null,
                relation: null,
                isMainUser: false,
            },
        };
    };

    const sanitizedMonitorReports = monitorReports
        .map(sanitizeMonitorReport)
        .map(addMemberDetailsToReport);
    const monitorReportsByUser = groupReportsByUserId(sanitizedMonitorReports);

    const buildPersonDetails = (person) => {
        const key = String(person._id);
        const personMonitorReports = monitorReportsByUser[key] || [];

        return {
            ...person,
            reports: {
                monitorReports: personMonitorReports,
                summary: {
                    monitor: buildReportSummary(personMonitorReports),
                },
            },
        };
    };

    const allMonitorReports = sanitizedMonitorReports.map((report) => ({
        ...report,
        reportType: 'monitor',
    }));

    const consultancyHistory = consultancies.map((consultancy) => {
        const key = String(consultancy.userId);

        return {
            ...consultancy,
            relation: memberMetaByUserId[key]?.relation || null,
        };
    });

    const mergedReports = [...allMonitorReports].sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return rightTime - leftTime;
    });

    return {
        status: 200,
        body: {
            success: true,
            data: {
                mainUser: buildPersonDetails(mainUser),
                familyMembers: familyMembers.map((member) => buildPersonDetails(member)),
                currentPlan: currentPurchase ? addPurchaseValidityInfo(currentPurchase) : null,
                planPurchases: purchases.map((purchase) => addPurchaseValidityInfo(purchase)),
                consultancyHistory,
                reports: {
                    allReports: mergedReports,
                    mainUser: {
                        monitorReports: monitorReportsByUser[mainUserKey] || [],
                    },
                    familyMembers: familyMembers.map((member) => {
                        const key = String(member._id);

                        return {
                            memberId: key,
                            full_name: member.full_name,
                            relation: member.relation || null,
                            reports: {
                                monitorReports: monitorReportsByUser[key] || [],
                            },
                        };
                    }),
                },
            },
        },
    };
};

// const appAdminSignUp = async (req, res) => {
//     const { email, phoneNumber, password } = req.body;

//     const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;

//     if (!emailRegex.test(email)) {
//         return res.status(400).json({ message: 'Invalid email format' });
//     }

//     try {
//         const adminExists = await AppAdmin.findOne({ $or: [{ email }, { phoneNumber }] });

//         if (adminExists) {
//             return res.status(400).json({ message: 'AppAdmin already exists with this email/phone number' });
//         }

//         const hashedPassword = await bcrypt.hash(password, 10);

//         const admin = await AppAdmin.create({
//             email,
//             phoneNumber,
//             password: hashedPassword,
//         });

//         res.status(201).json({
//             _id: admin._id,
//             email: admin.email,
//             phoneNumber: admin.phoneNumber,
//         });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({ message: 'Error registering user' });
//     }
// };

const appAdminSignIn = async (req, res) => {
    const { email, phoneNumber, password } = req.body;

    try {
        const user = await AppAdmin.findOne({ $or: [{ email }, { phoneNumber }] });

        if (!user) {
            return res.status(401).json({ message: 'Invalid email/phone number or password' });
        }

        // const isMatch = await bcrypt.compare(password, user.password);
        // if (!isMatch) {
        //     return res.status(401).json({ message: 'Invalid email/phone number or password' });
        // }
        if (password !== user.password) {
            return res.status(401).json({ message: 'Invalid email/phone number or password' });
        }
        
        const token = generateToken(user._id);

        res.status(200).json({
            _id: user._id,
            email: user.email,
            phoneNumber: user.phoneNumber,
            token,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error logging in' });
    }
};

const getappAdminProfile = async (req, res) => {
    try {
        const user = await AppAdmin.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'Admin not found' });
        }

        res.status(200).json({
            _id: user._id,
            email: user.email,
            phoneNumber: user.phoneNumber,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching Admin profile' });
    }
};

const updateappAdminProfile = async (req, res) => {
    const { email, phoneNumber } = req.body;

    try {
        const user = await AppAdmin.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'Admin not found' });
        }

        user.email = email || user.email;
        user.phoneNumber = phoneNumber || user.phoneNumber;

        await user.save();

        res.status(200).json({
            _id: user._id,
            email: user.email,
            phoneNumber: user.phoneNumber,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error updating profile' });
    }
};

const appAdminchangePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        const user = await AppAdmin.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (oldPassword !== user.password) return res.status(400).json({ message: "Old password is incorrect" });
        // if (!isMatch) return res.status(400).json({ message: "Old password is incorrect" });

        // const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = newPassword;

        await user.save();

        res.status(200).json({ message: "Password changed successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAllUser = async (req, res) => {
    try {
        const users = await User.find()
            .select('-password')
            .populate('subscription.planId')
            .populate({
                path: 'subscription.purchaseId',
                populate: {
                    path: 'planId',
                    select: 'title planType iconType price currency billingCycle features isActive',
                },
            })
            .sort({ createdAt: -1 })
            .lean();

        const userIds = users.map((user) => user._id);

        const allPurchases = await PlanPurchase.find({ userId: { $in: userIds } })
            .populate('planId', 'title planType iconType price currency billingCycle features isActive')
            .sort({ createdAt: -1 })
            .lean();

        const purchasesByUserId = allPurchases.reduce((accumulator, purchase) => {
            const key = String(purchase.userId);

            if (!accumulator[key]) {
                accumulator[key] = [];
            }

            accumulator[key].push(addPurchaseValidityInfo(purchase));
            return accumulator;
        }, {});

        const enrichedUsers = users.map((user) => {
            const key = String(user._id);
            const planPurchases = purchasesByUserId[key] || [];
            const currentPlan = planPurchases.find((purchase) => purchase.isCurrent) || null;

            return {
                ...user,
                planDetails: {
                    subscription: user.subscription || null,
                    currentPlan,
                    allPurchases: planPurchases,
                    totalPurchases: planPurchases.length,
                },
            };
        });

        res.json({
            success: true,
            totalUsers: enrichedUsers.length,
            users: enrichedUsers
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            message: "Read all failed", 
            error: error.message 
        });
    }
};

const getUserById = async (req, res) => {
    try {
        const result = await buildUserDetailsPayload(req.params.id);

        return res.status(result.status).json(result.body);
    } catch (error) {
        res.status(500).json({ message: "Read failed", error: error.message });
    }
}

const userStatusUpdate = async (req, res) => {
    try {
        const { status } = req.body;

        if (!['active', 'blocked'].includes(status)) {
            return res.status(400).json({ 
                message: "Invalid status value. Must be either 'active' or 'blocked'" 
            });
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { status },
            { returnDocument: 'after' }
        );

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json({
            message: `User ${status === 'blocked' ? 'blocked' : 'activated'} successfully`,
            user
        });
    } catch (error) {
        res.status(500).json({ 
            message: "Failed to update user status", 
            error: error.message
        });
    }
};

const deleteUser = async (req, res) => {
    try {
      const deleteUser = await User.findByIdAndDelete(req.params.id);
      if (!deleteUser) 
          return res.status(404).json({ message: "User not found" });
      res.json({ message: "User deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Delete failed", error: error.message });
    }
}

const getUserWithFamilyById = async (req, res) => {
    try {
        const result = await buildUserDetailsPayload(req.params.id);

        return res.status(result.status).json(result.body);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Server Error',
        });
    }
};


// const appAdmindeleteUserProfile = async (req, res) => {
//     try {
//         const user = await User.findByIdAndDelete(req.user._id);

//         if (!user) {
//             return res.status(404).json({ message: 'User not found' });
//         }

//         res.status(200).json({ message: 'User deleted successfully' });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({ message: 'Error deleting user' });
//     }
// };

export {
    // appAdminSignUp,
    appAdminSignIn,
    getappAdminProfile,
    updateappAdminProfile,
    appAdminchangePassword,
    getAllUser,
    getUserById,
    userStatusUpdate,
    getUserWithFamilyById,
    deleteUser
    // appAdmindeleteUserProfile
};