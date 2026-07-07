import express from 'express';
import {
	storeEcgData,
	getEcgData,
	streamLiveEcg,
	streamMonitorLiveEcg,
	getMonitorEcgData,
	deleteMonitorEcgData,
	getAllMonitorEcgDataWithUsers,
	getMembersWithMonitorDataByUser,
	setMonitorSession,
	updateDeviceResult,
	getEcgAndAbnormalityByUserId,
	getEcgListByUserDateWise,
	getAdminAllReports,
	getAdminReportDetails,
	getActiveLiveUsers,
	streamActiveLiveUsers,
} from '../controllers/ecgController.js';

const router = express.Router();

router.post('/', storeEcgData);
router.post('/monitor/session', setMonitorSession);
router.put('/device_result', updateDeviceResult);
router.get('/admin/all-reports', getAdminAllReports);
router.get('/admin/all-reports/:monitorId', getAdminReportDetails);
router.get('/monitor/live/:deviceId/:userId', streamMonitorLiveEcg);
router.get('/monitor/all/with-users', getAllMonitorEcgDataWithUsers);
router.get('/monitor/members-with-data/:userId', getMembersWithMonitorDataByUser);
router.get('/monitor/:monitorId', getMonitorEcgData);
router.delete('/monitor/:monitorId', deleteMonitorEcgData);
router.get('/user/:userId/all-with-abnormality', getEcgAndAbnormalityByUserId);
router.get('/user/:userId/list-by-date', getEcgListByUserDateWise);
router.get('/live-status/active', getActiveLiveUsers);
router.get('/live-status/stream', streamActiveLiveUsers);
router.get('/live/:deviceId', streamLiveEcg);
router.get('/:deviceId', getEcgData);

export default router;
