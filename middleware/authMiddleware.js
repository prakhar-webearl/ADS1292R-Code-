import jwt from "jsonwebtoken";
import AppAdmin from "../models/appAdminModel.js"
import User from "../models/userModel.js" 
import Doctor from "../models/doctorModel.js";

const AppAdminprotect = async (req, res, next) => {
    try {
        // console.log("Headers:", req.headers); // Debugging log
        let token = req.headers.authorization;
        if (!token) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        if (token.startsWith("Bearer ")) {
            token = token.split(" ")[1]; 
        }

        const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET);

        req.user = await AppAdmin.findById(decoded.id).select("-password");
        if (!req.user) {
            return res.status(401).json({ message: "User not found" });
        }

        next();
    } catch (error) {
        return res.status(401).json({ message: "Not authorized, invalid token" });
    }
};


const protect = async (req, res, next) => {
    try {
        // console.log("Headers:", req.headers); // Debugging log
        let token = req.headers.authorization;
        if (!token) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        if (token.startsWith("Bearer ")) {
            token = token.split(" ")[1]; 
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        req.user = await User.findById(decoded.id).select("-password");
        console.log("User:", req.user); // Debugging log
        if (!req.user) {
            return res.status(401).json({ message: "User not found" });
        }

        next();
    } catch (error) {
        return res.status(401).json({ message: "Not authorized, invalid token" });
    }
};

const protectDoctor = async (req, res, next) => {
    try {
        let token = req.headers.authorization;
        if (!token) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        if (token.startsWith("Bearer ")) {
            token = token.split(" ")[1];
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        req.doctor = await Doctor.findById(decoded.id).select("-password");
        if (!req.doctor) {
            return res.status(401).json({ message: "Doctor not found" });
        }

        next();
    } catch (error) {
        return res.status(401).json({ message: "Not authorized, invalid token" });
    }
};

const protectUniversal = async (req, res, next) => {
    try {
        let token = req.headers.authorization;
        if (!token) {
            return res.status(401).json({ message: "Not authorized, no token" });
        }

        if (token.startsWith("Bearer ")) {
            token = token.split(" ")[1];
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Try to find as User first
        const user = await User.findById(decoded.id).select("-password");
        if (user) {
            req.user = user;
            req.userType = "User";
            return next();
        }

        // Try to find as Doctor
        const doctor = await Doctor.findById(decoded.id).select("-password");
        if (doctor) {
            req.doctor = doctor;
            req.userType = "Doctor";
            return next();
        }

        return res.status(401).json({ message: "User/Doctor not found" });
    } catch (error) {
        return res.status(401).json({ message: "Not authorized, invalid token" });
    }
};

export {
    protect,
    AppAdminprotect,
    protectDoctor,
    protectUniversal
}