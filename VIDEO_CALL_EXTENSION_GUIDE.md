# Video Call Extension Flow Guide

This guide prevents repeated extension popups and keeps user and doctor clients in sync.

## What was fixed in backend

Backend file updated:
- controllers/videoCallController.js

Fixes:
1. Session rollover is now explicit. When extension is accepted by both sides, the current session is closed and a fresh session slot starts.
2. Closed sessions are never resumed by timer restart logic.
3. Duplicate extension requests for the same session are ignored.
4. Existing session timers are cleared when extension request starts, so end-of-session does not trigger a second request for the same slot.
5. Duplicate user/doctor responses for the same extension request are treated as idempotent and ignored.

## Event contract you should handle

Socket event channel: video_call:update

Important callData.event values:
- session_started
- extension_requested
- extension_accepted
- session_ended

For extension acceptance sync:
- extension_accepted includes:
  - sessionDurationMs (full new slot duration)
  - remainingMs (authoritative remaining time from server)
  - sessionStartedAt (ISO timestamp for fallback drift correction)
  - sessionIndex

## Flutter (User app) integration rules

State you should keep per room:
- lastHandledExtensionSessionIndex
- extensionDialogOpen
- timerEndEpochMs

Rules:
1. Show extension popup only when:
   - event is extension_requested
   - current user role is User
   - popup is not already open
   - sessionIndex is newer than lastHandledExtensionSessionIndex
2. When user presses Accept:
   - call POST /api/video-call/respond-extension with:
     - roomId
     - sessionIndex
     - response: accepted
     - userType: User
   - disable button after first tap until response returns
3. On extension_accepted:
   - close popup
   - set lastHandledExtensionSessionIndex = payload.sessionIndex
   - restart countdown using remainingMs
   - if remainingMs missing, compute using sessionDurationMs - (now - sessionStartedAt)
4. Ignore duplicate extension_requested for same sessionIndex.
5. Ignore extension_accepted if payload.sessionIndex is older than active session.

Suggested Flutter timer logic (pseudo):

- onVideoUpdate(payload):
  - if payload.event == extension_requested and role == User:
    - if payload.sessionIndex <= lastHandledExtensionSessionIndex: return
    - if extensionDialogOpen: return
    - openDialog()
  - if payload.event == extension_accepted:
    - closeDialogIfOpen()
    - lastHandledExtensionSessionIndex = payload.sessionIndex
    - remaining = payload.remainingMs ?? computeFromStartedAt(payload)
    - startCountdown(remaining)

## Web (Doctor panel) integration rules

State you should keep per room:
- doctorPromptSessionIndex
- doctorPromptVisible
- responding

Rules:
1. Show extension popup only when:
   - event is extension_requested
   - current role is Doctor
   - doctorPromptVisible is false
   - payload.sessionIndex is newer than doctorPromptSessionIndex
2. When doctor presses Accept/Reject:
   - call POST /api/video-call/respond-extension with:
     - roomId
     - sessionIndex
     - response: accepted or rejected
     - userType: Doctor
   - set responding=true and disable action buttons until API returns
3. On extension_accepted:
   - close doctor popup
   - doctorPromptSessionIndex = payload.sessionIndex
   - restart timer from remainingMs
4. Ignore repeated extension_requested with same sessionIndex.

Suggested web reducer guard:
- if incoming.event == extension_requested:
  - if incoming.sessionIndex <= state.doctorPromptSessionIndex: return state
  - if state.doctorPromptVisible: return state
  - show prompt

## API request examples

User accept:
POST /api/video-call/respond-extension
{
  "roomId": "<roomId>",
  "sessionIndex": 1,
  "response": "accepted",
  "userType": "User"
}

Doctor accept:
POST /api/video-call/respond-extension
{
  "roomId": "<roomId>",
  "sessionIndex": 1,
  "response": "accepted",
  "userType": "Doctor"
}

Doctor reject:
POST /api/video-call/respond-extension
{
  "roomId": "<roomId>",
  "sessionIndex": 1,
  "response": "rejected",
  "userType": "Doctor"
}

## Quick checklist for your clients

- De-duplicate by sessionIndex
- Prevent double-click submits
- Use remainingMs as source of truth for countdown reset
- Treat extension_accepted as timer reset event
- Keep one popup instance per room

## Handling reject / timeout / session end (frontend)

Make sure both user and doctor clients close the extension UI and end the call when the server signals an end. Server events to handle:
- `extension_request_closed`: resolution for the pending request (status: `accepted` or `rejected`). Close any extension modal immediately.
- `extension_accepted`: start the extended session timer using `remainingMs`.
- `session_ended`: final end of call (reason: `no_credits` or `extension_rejected_or_timeout`). Close call UI and navigate back.

Important: when the doctor or user explicitly rejects the extension, the server now emits `extension_request_closed` with `status: 'rejected'` and `session_ended` immediately — clients must NOT wait for the original 20s pre-expiry prompt. Handle `extension_request_closed.status === 'rejected'` by closing the modal and ending the call UI immediately.

Flutter (socket handler) — minimal:

```dart
socket.on('video_call:update', (data) {
  final callData = data['callData'] as Map<String, dynamic>;
  final event = callData['event'] as String?;
  if (event == 'extension_request_closed') {
    // close extension modal and disable buttons
    closeExtensionModal();
    // when rejected, backend also sends status: 'rejected' and session_ended — end the call
    if ((callData['status'] as String?) == 'rejected') {
      stopCountdown();
      leaveCallRoom();
    }
  } else if (event == 'extension_accepted') {
    closeExtensionModal();
    final remaining = callData['remainingMs'] as int? ?? 0;
    startCountdown(remaining);
  } else if (event == 'session_ended') {
    // show message, stop timers and leave room
    showEndMessage(callData['message']);
    stopCountdown();
    leaveCallRoom();
  }
});
```

Web (React) — minimal:

```javascript
socket.on('video_call:update', (payload) => {
  const event = payload.callData?.event;
  if (event === 'extension_request_closed') {
    setExtensionOpen(false);
    if (payload.callData?.status === 'rejected') {
      // end immediately on reject
      stopTimer();
      closeCallUI();
    }
  }
  if (event === 'extension_accepted') {
    setExtensionOpen(false);
    startTimer(payload.callData.remainingMs);
  }
  if (event === 'session_ended') {
    toast.info(payload.callData.message || 'Session ended');
    stopTimer();
    closeCallUI();
  }
});
```

Notes and fail-safes:
- If sockets are unreliable (ngrok vs localhost), also poll `GET /api/video-call/:roomId?userId=...` periodically (every 10s) while the call UI is open and close if `videoCall.status` becomes `completed`.
- Always de-duplicate by `sessionIndex` so late/out-of-order events don't re-open the modal.
- When you receive `session_ended`, perform cleanup: stop timers, disconnect media, and navigate away.
- Server emits both a live socket update and creates a persisted `Notification` record; doctor UI can also fetch `GET /api/notification/getAll?userId=DOCTOR_ID` to recover missed events.

