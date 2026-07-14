import sys

with open('src/main.cpp', 'r', encoding='utf-8') as f:
    content = f.read()

process_idx = content.find('static void processBlock() {')
if process_idx != -1:
    p1 = content.find('pipeline.processBlock(blk);', process_idx)
    p2 = content.find('pipeline.processBlock(blk);', p1 + 1)
    p3 = content.find('pipeline.processBlock(blk);', p2 + 1)
    if p3 != -1:
        end_idx = content.find('}', p3)
        new_logic = '''pipeline.processBlock(blk);

    // Append to analysis window
    for (int i = 0; i < WINDOW_SIZE; i++) {
        g_analysisWindow[g_analysisWriteIndex] = blk.data[i];
        g_analysisWriteIndex = (g_analysisWriteIndex + 1) % ANALYSIS_WINDOW_SIZE;
        if (g_analysisSampleCount < ANALYSIS_WINDOW_SIZE) {
            g_analysisSampleCount++;
        }
    }

    String condition = "Warming up";
    String severity = "INFO";
    String detail = String(g_analysisSampleCount / WINDOW_SIZE) + "/5 seconds collected";

    if (g_analysisSampleCount >= ANALYSIS_WINDOW_SIZE) {
        int32_t scaledSnapshot[ANALYSIS_WINDOW_SIZE];
        uint32_t start = g_analysisWriteIndex;
        for (int i = 0; i < ANALYSIS_WINDOW_SIZE; i++) {
            int32_t val = (g_analysisWindow[(start + i) % ANALYSIS_WINDOW_SIZE] >> 6) + 2048;
            if (val > 4095) val = 4095;
            if (val < 0) val = 0;
            scaledSnapshot[i] = val;
        }
        condition = classifyWindow(scaledSnapshot, ANALYSIS_WINDOW_SIZE, severity, detail);
    }

    if (severity == "CRITICAL" || severity == "WARNING") {
        unsigned long now = millis();
        bool isNewEpisode = (condition != g_lastAlertCondition) || (now - g_lastAlertMs > ALERT_COOLDOWN_MS);

        digitalWrite(ALERT_LED_PIN, HIGH);
        if (isNewEpisode) {
            triggerCriticalAlert(severity == "CRITICAL" ? 2 : 1);
            g_lastAlertCondition = condition;
            g_lastAlertMs = now;
        }
    } else {
        buzzerOff();
        digitalWrite(ALERT_LED_PIN, LOW);
        g_lastAlertCondition = "";
    }

    network_uploadBlock(blk, false, loPlus, loMinus, condition.c_str(), severity.c_str());
    g_validBlocks++;
'''
        content = content[:p3] + new_logic + content[end_idx:]

with open('src/main.cpp', 'w', encoding='utf-8') as f:
    f.write(content)
