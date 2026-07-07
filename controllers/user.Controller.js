import User from '../models/userModel.js';
import Plan from '../models/planModel.js';
import PlanPurchase from '../models/planPurchaseModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const generateToken = (userId) => {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
        expiresIn: '7d', 
    });
};

const isBcryptHash = (value) => {
    return typeof value === 'string' && /^\$2[aby]?\$/.test(value);
};

const calculatePlanExpiry = (billingCycle, startsAt) => {
    if (billingCycle === 'lifetime') return null;

    const expiry = new Date(startsAt);
    if (billingCycle === 'yearly') {
        expiry.setFullYear(expiry.getFullYear() + 1);
    } else {
        expiry.setMonth(expiry.getMonth() + 1);
    }
    return expiry;
};

const assignDefaultFreePlanToUser = async (userId) => {
    const existingCurrentPlan = await PlanPurchase.findOne({ userId, isCurrent: true });
    if (existingCurrentPlan) {
        return { assigned: false, reason: 'User already has active/current plan' };
    }

    const freePlan = await Plan.findOne({
        isActive: true,
        planType: 'basic',
        price: 0,
    }).sort({ sortOrder: 1, createdAt: 1 });

    if (!freePlan) {
        return { assigned: false, reason: 'No active free basic plan found' };
    }

    const now = new Date();
    const expiresAt = calculatePlanExpiry(freePlan.billingCycle, now);

    const purchase = await PlanPurchase.create({
        userId,
        planId: freePlan._id,
        planSnapshot: {
            title: freePlan.title,
            status: freePlan.status,
            price: freePlan.price,
            currency: freePlan.currency,
            billingCycle: freePlan.billingCycle,
            consultancyCount: freePlan.consultancyCount,
            features: freePlan.features,
        },
        amount: 0,
        currency: freePlan.currency || 'INR',
        paymentMethod: 'none',
        purchaseStatus: 'active',
        isCurrent: true,
        startsAt: now,
        expiresAt,
        notes: 'Auto-assigned free basic plan on signup',
    });

    await User.findByIdAndUpdate(userId, {
        subscription: {
            planId: freePlan._id,
            purchaseId: purchase._id,
            status: 'active',
            startedAt: now,
            expiresAt,
        },
    });

    return {
        assigned: true,
        planId: freePlan._id,
        planTitle: freePlan.title,
        purchaseId: purchase._id,
    };
};

const SignUp = async (req, res) => {
    const {
        full_name,
        email,
        password,
        phoneNumber,
        dob,
        age,
        gender,
        weight,
        height,
        agree_terms_condition,
        privacy_policy,
        country,
        state,
        city,
    } = req.body;

    if (!full_name || !email || !password) {
        return res.status(400).json({ message: 'Full name, email, and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

    if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ message: 'Invalid email format' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    try {
        const userExists = await User.findOne({ email: normalizedEmail });

        if (userExists) {
            return res.status(400).json({ message: 'User already exists with this email' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await User.create({
            full_name,
            email: normalizedEmail,
            password: hashedPassword,
            phoneNumber,
            dob,
            age,
            gender,
            weight,
            height,
            agree_terms_condition,
            privacy_policy,
            country,
            state,
            city,
        });

        const autoPlan = await assignDefaultFreePlanToUser(user._id);

        const token = generateToken(user._id);

        res.status(201).json({
            message: 'User registered successfully',
            _id: user._id,
            full_name: user.full_name,
            email: user.email,
            country: user.country,
            state: user.state,
            city: user.city,
            autoPlanAssigned: autoPlan.assigned,
            autoPlan,
            token,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error registering user' });
    }
};

const SignIn = async (req, res) => {
    const { email, phoneNumber, password } = req.body;

    if (!email && !phoneNumber) {
        return res.status(400).json({ message: 'Email or phoneNumber is required' });
    }

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    try {
        const user = await User.findOne({ $or: [{ email }, { phoneNumber }] });

        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (!user.password) {
            return res.status(400).json({
                message: 'This account does not have a password set. Please reset your password.',
            });
        }

        const isMatch = isBcryptHash(user.password)
            ? await bcrypt.compare(password, user.password)
            : password === user.password;

        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const token = generateToken(user._id);

        res.status(200).json({
            message: 'Login successful',
            _id: user._id,
            full_name: user.full_name,
            email: user.email,
            phoneNumber: user.phoneNumber,
            dob: user.dob,
            age: user.age,
            gender: user.gender,
            weight: user.weight,
            height: user.height,
            country: user.country,
            state: user.state,
            city: user.city,
            agree_terms_condition: user.agree_terms_condition,
            privacy_policy: user.privacy_policy,
            status: user.status,
            token,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error logging in' });
    }
};

const getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id); 

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.status(200).json({
            _id: user._id,
            full_name: user.full_name,
            email: user.email,
            phoneNumber: user.phoneNumber,
            dob: user.dob,
            age: user.age,
            gender: user.gender,
            weight: user.weight,
            height: user.height,
            country: user.country,
            state: user.state,
            city: user.city,
            agree_terms_condition: user.agree_terms_condition,
            privacy_policy: user.privacy_policy,
            status: user.status,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching user profile' });
    }
};

const updateUserProfile = async (req, res) => {
    const { full_name, email, phoneNumber, dob, age, gender, weight, height, agree_terms_condition, privacy_policy, country, state, city } = req.body;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (full_name !== undefined) user.full_name = full_name;
        if (email !== undefined) user.email = email;
        if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
        if (dob !== undefined) user.dob = dob;
        if (age !== undefined) user.age = age;
        if (gender !== undefined) user.gender = gender;
        if (weight !== undefined) user.weight = weight;
        if (height !== undefined) user.height = height;
        if (agree_terms_condition !== undefined) user.agree_terms_condition = agree_terms_condition;
        if (privacy_policy !== undefined) user.privacy_policy = privacy_policy;
        if (country !== undefined) user.country = country;
        if (state !== undefined) user.state = state;
        if (city !== undefined) user.city = city;

        await user.save();

        res.status(200).json({
            message: 'Profile updated successfully',
            _id: user._id,
            full_name: user.full_name,
            email: user.email,
            phoneNumber: user.phoneNumber,
            dob: user.dob,
            age: user.age,
            gender: user.gender,
            weight: user.weight,
            height: user.height,
            agree_terms_condition: user.agree_terms_condition,
            privacy_policy: user.privacy_policy,
            country: user.country,
            state: user.state,
            city: user.city,
            status: user.status,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error updating profile' });
    }
};

// Simple static location endpoints. Replace with DB or third-party data as needed.
const COUNTRIES = [
    { code: 'IN', name: 'India' },
    { code: 'US', name: 'United States' },
    { code: 'GB', name: 'United Kingdom' },
];

const STATES = {
    IN: [ 'Maharashtra', 'Karnataka', 'Delhi' ],
    US: [ 'California', 'Texas', 'New York' ],
    GB: [ 'England', 'Scotland', 'Wales' ],
};

const CITIES = {
    Maharashtra: [ 'Mumbai', 'Pune', 'Nagpur' ],
    Karnataka: [ 'Bengaluru', 'Mysore' ],
    Delhi: [ 'New Delhi' ],
    California: [ 'Los Angeles', 'San Francisco' ],
    Texas: [ 'Houston', 'Dallas' ],
    'New York': [ 'New York City', 'Buffalo' ],
    England: [ 'London', 'Manchester' ],
    Scotland: [ 'Edinburgh', 'Glasgow' ],
    Wales: [ 'Cardiff' ],
};

const getCountries = async (req, res) => {
    res.status(200).json(COUNTRIES);
};

const getStatesByCountry = async (req, res) => {
    const country = req.params.country;
    const countryObj = COUNTRIES.find(c => c.code === country || c.name.toLowerCase() === country.toLowerCase());
    if (!countryObj) return res.status(404).json({ message: 'Country not found' });
    const states = STATES[countryObj.code] || [];
    res.status(200).json(states);
};

const getCitiesByState = async (req, res) => {
    const state = req.params.state;
    const cities = CITIES[state] || [];
    if (!cities.length) return res.status(404).json({ message: 'State not found or no cities available' });
    res.status(200).json(cities);
};

const changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        // Find user by ID
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // Compare old password
        const isMatch = isBcryptHash(user.password)
            ? await bcrypt.compare(oldPassword, user.password)
            : oldPassword === user.password;
        if (!isMatch) return res.status(400).json({ message: "Old password is incorrect" });

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;

        // Save user with new password
        await user.save();

        res.status(200).json({ message: "Password changed successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const forgetPassword = async (req, res) => {
    try {
        const { email, phoneNumber, newPassword } = req.body;

        if (!email && !phoneNumber) {
            return res.status(400).json({ success: false, message: 'Email or PhoneNumber is required' });
        }

        const user = await User.findOne({ $or: [{ email }, { phoneNumber }] });
        if (!user) {
            return res.status(404).json({ success: false, message: 'No user found with this email or PhoneNumber' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        await user.save();

        return res.status(200).json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

// const deleteUserProfile = async (req, res) => {
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
    SignUp,
    SignIn,
    getUserProfile,
    updateUserProfile,
    changePassword,
    forgetPassword
    ,
    getCountries,
    getStatesByCountry,
    getCitiesByState
    // deleteUserProfile
}