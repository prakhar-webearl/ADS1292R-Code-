import EcgData from '../models/EcgData.js';
import { liveClients } from './ecgController.js';

// @desc    Store AI Result data (updates existing ECG chunks and broadcasts live)
// @route   POST /api/result
// @access  Public
export const storeAiResult = async (req, res) => {
  try {
    let { device_id, results } = req.body;

    console.log(`\n[API HIT] POST /api/result received payload.`);

    // If device_id is missing at the root of the JSON payload, fetch it from the first result item
    if (!device_id && results && results.length > 0) {
      device_id = results[0].deviceId;
    }

    if (!device_id || !Array.isArray(results)) {
      console.log(`[API Error] device_id or results array missing.`);
      return res.status(400).json({
        success: false,
        message: 'device_id and results array are required',
      });
    }

    console.log(`[AI Data Processing] Device: ${device_id} | Processing ${results.length} records...`);

    // Bulk update approach for efficiency
    const bulkOps = results.map((result) => {
      const {
        deviceId,
        recordId,
        seq,
        prediction,
        confidence,
        alert_level,
        detection_method,
        heart_rate,
        rr_interval,
        rr_variation,
        rmssd,
        not_normal_reasons,
        top3,
        timestamp,
        source_time,
      } = result;

      // Ensure robust matching: Use recordId only if it is a valid 24-char MongoDB ObjectId
      const isValidObjectId = recordId && /^[0-9a-fA-F]{24}$/.test(recordId);
      const filterObj = isValidObjectId 
        ? { _id: recordId } 
        : { deviceId: deviceId || device_id, seq };

      console.log(` -> Preparing update for Seq: ${seq} | Prediction: ${prediction} | recordId: ${isValidObjectId ? recordId : 'Fallback to seq'}`);

      return {
        updateOne: {
          filter: filterObj,
          update: {
            $set: {
              deviceId: deviceId || device_id,
              seq: seq,
              ai_result: {
                prediction,
                confidence,
                alert_level,
                detection_method,
                heart_rate,
                rr_interval,
                rr_variation,
                rmssd,
                not_normal_reasons,
                top3,
                timestamp,
                source_time,
              },
            },
            // If the chunk doesn't exist yet, insert it with empty data so the AI result isn't lost
            $setOnInsert: {
              data: [],
              sr: 360,
              lo: false,
            }
          },
          upsert: true, // Create the document if it doesn't exist yet
        },
      };
    });

    // Execute all updates in one go (ordered: false means if one fails, the rest still process!)
    const bulkWriteResult = await EcgData.bulkWrite(bulkOps, { ordered: false });

    console.log(`[AI Update Success] Device: ${device_id} | Payload size: ${results.length} | Matched: ${bulkWriteResult.matchedCount} | Modified: ${bulkWriteResult.modifiedCount} | Upserted: ${bulkWriteResult.upsertedCount}`);

    // Fetch the completely updated DB objects so the Live Stream shares everything (data, result, ai_result)
    const updatedSeqs = results.map(r => r.seq);
    const updatedRecords = await EcgData.find({
      deviceId: device_id,
      seq: { $in: updatedSeqs }
    });

    // --- Broadcast Live AI Results to connected SSE clients ---
    const payloadString = JSON.stringify({ type: 'ai_results', results: updatedRecords });
    
    // Broadcast to the central ECG stream...
    liveClients.forEach(client => {
      if (client.deviceId === device_id) {
        client.res.write(`data: ${payloadString}\n\n`);
      }
    });

    // ...AND Broadcast to the new dedicated Results stream
    resultClients.forEach(client => {
      if (client.deviceId === device_id) {
        client.res.write(`data: ${payloadString}\n\n`);
      }
    });

    res.status(200).json({
      success: true,
      message: `Successfully updated records for device ${device_id}.`,
      stats: {
        matched: bulkWriteResult.matchedCount,
        modified: bulkWriteResult.modifiedCount,
        upserted: bulkWriteResult.upsertedCount
      }
    });
  } catch (error) {
    // If it's a BulkWriteError, print exactly which items failed
    if (error.writeErrors) {
      console.error(`[AI Bulk Update Partially Failed] Device: ${req.body.device_id} had ${error.writeErrors.length} write errors.`);
      console.error(error.writeErrors.map(e => e.errmsg));
    } else {
      console.error(`[AI Update Error] Failed: ${error.message}`);
    }
    
    res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message,
    });
  }
};
export let resultClients = [];

// @desc    Get LIVE Real-Time AI Results stream using Server-Sent Events (SSE)
// @route   GET /api/result/live/:deviceId
// @access  Public
export const streamLiveResults = async (req, res) => {
  const { deviceId } = req.params;

  // Set headers critical for Server-Sent Events (SSE)
  res.setHeader("Content-Type", "text-event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Send an initial connection event
  res.write(`data: ${JSON.stringify({ message: `Connected to live results stream for ${deviceId}` })}\n\n`);

  try {
    // Send the most recent results immediately upon connection
    const recentRecords = await EcgData.find({ deviceId, ai_result: { $exists: true } }).sort({ createdAt: -1 }).limit(10);
    if (recentRecords.length > 0) {
      const chronological = recentRecords.reverse();
      chronological.forEach(record => {
        res.write(`data: ${JSON.stringify({ type: 'ai_results', data: record })}\n\n`);
      });
    }
  } catch (error) {
    console.error(`Error sending initial live results: ${error.message}`);
  }

  const clientId = Date.now();
  
  // Add this new client connection to our array
  const newClient = {
    id: clientId,
    deviceId,
    res
  };
  resultClients.push(newClient);

  // When the client closes the connection, safely remove them from the array
  req.on('close', () => {
    console.log(`Live Results Stream client disconnected: ${clientId}`);
    resultClients = resultClients.filter(client => client.id !== clientId);
  });
};
