import express from 'express';
import { changePassword, forgetPassword, getUserProfile, SignIn, SignUp, updateUserProfile, getCountries, getStatesByCountry, getCitiesByState } from '../controllers/user.Controller.js';
import { getConsultancyDetailsById } from '../controllers/consultancy.Controller.js';
import { protect } from '../middleware/authMiddleware.js';
import {
	getUserPlans,
	getUserPlanById,
	purchasePlan,
	createPlanPurchaseOrder,
	verifyPlanPurchasePayment,
	getMyPlanPurchases,
	getMyCurrentPlan,
} from '../controllers/plan.Controller.js';
import { getAllTest, getTestById } from '../controllers/test.Controller.js';
import { getAllArticles, getArticleById, getHomeTopBlogs } from '../controllers/article.Controller.js';
import { getAllHelp, getHelpById } from '../controllers/help.Controller.js';
import { getAllPrivacyPolicy, getPrivacyPolicyById } from '../controllers/privacyPolicy.Controller.js';
import { getAllTermsCondition, getTermsConditionById } from '../controllers/termsCondition.Controller.js';


const router = express.Router();

router.post('/signup', SignUp);
router.post('/signin', SignIn);
router.get('/getprofile', protect, getUserProfile);
router.put('/updateprofile', protect, updateUserProfile);
router.put('/changepassword', protect, changePassword);
router.post("/forgotPassword", forgetPassword);
// router.delete('/deleteprofile', protect, deleteUserProfile);

// GET Plan
router.get('/plan/getallplans', protect, getUserPlans);
router.get('/plan/getplan/:id', protect, getUserPlanById);
router.post('/plan/create-order', protect, createPlanPurchaseOrder);
router.post('/plan/verify-payment', protect, verifyPlanPurchasePayment);
router.post('/plan/purchase', protect, purchasePlan);
router.get('/plan/my-purchases', protect, getMyPlanPurchases);
router.get('/plan/current', protect, getMyCurrentPlan);

// Get Test 
router.get ('/test/getalltest', protect, getAllTest);
router.get ('/test/getById/:id', protect, getTestById);

// Get Articles
router.get ('/article/getAllArticles', protect, getAllArticles);
router.get ('/article/getById/:id', protect, getArticleById);
router.get('/home/top-blogs', protect, getHomeTopBlogs);

// HELP AND SUPPORT
router.get('/help/getAll', protect, getAllHelp);
router.get('/help/getById/:id', protect, getHelpById);

// Privacy Policy
router.get('/privacypolicy/getAll', protect, getAllPrivacyPolicy);
router.get('/privacypolicy/getById/:id', protect, getPrivacyPolicyById);

// Terms & Condition
router.get('/termscondition/getAll', protect, getAllTermsCondition);
router.get('/termscondition/getById/:id', protect, getTermsConditionById);

// Consultancy details
router.get('/consultancy/details/:consultancyId', protect, getConsultancyDetailsById);

// Locations (public)
router.get('/locations/countries', getCountries);
router.get('/locations/states/:country', getStatesByCountry);
router.get('/locations/cities/:state', getCitiesByState);

export default router; 