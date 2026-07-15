# 📱 Flutter BLE Guide — SWET_IOT ECG Device

Complete guide to receive and display live ECG data from the **ESP32 ADS1292R** device in a Flutter app using raw binary BLE notifications.

---

## 📦 Device BLE Info

| Property | Value |
|---|---|
| **Device Name** | `ECG_Setup` |
| **Service UUID** | `12345678-1234-5678-1234-56789abcdef0` |
| **Characteristic UUID** | `12345678-1234-5678-1234-56789abcdef1` |
| **Properties** | NOTIFY + READ |
| **Packet Size** | **508 bytes** per notification (1 packet, no chunking) |

---

## 📦 Packet Layout

Every BLE notification from the device is exactly **508 bytes**, little-endian:

```
Offset  Size   Field          Type       Description
──────────────────────────────────────────────────────────────
 0       4     seq            uint32     Block sequence number
 4       1     sampleRate     uint8      Always 125 (Hz)
 5       1     flags          uint8      bit0=leadsOff, bit1=loPlusOff, bit2=loMinusOff
 6       1     severity       uint8      0=INFO, 1=WARNING, 2=CRITICAL
 7       1     numSamples     uint8      Always 125 samples
 8     500     samples[125]   int32[]    Raw signed ADC values (each 4 bytes, little-endian)
──────────────────────────────────────────────────────────────
TOTAL = 508 bytes
```

---

## 1. Add Dependencies

In your `pubspec.yaml`:

```yaml
dependencies:
  flutter_blue_plus: ^1.31.15
  fl_chart: ^0.68.0
  permission_handler: ^11.3.1
```

Run:
```bash
flutter pub get
```

---

## 2. Android Permissions

### `android/app/src/main/AndroidManifest.xml`

Add inside `<manifest>`:

```xml
<!-- BLE Permissions (Android 12+) -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />

<!-- BLE for Android < 12 -->
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

<!-- Feature declaration -->
<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

### `android/app/build.gradle`

```gradle
android {
    compileSdkVersion 34
    defaultConfig {
        minSdkVersion 21
        targetSdkVersion 34
    }
}
```

---

## 3. iOS Permissions

### `ios/Runner/Info.plist`

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app needs Bluetooth to receive ECG data from the device.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>This app needs Bluetooth to receive ECG data from the device.</string>
```

---

## 4. ECG Packet Model

Create `lib/models/ecg_packet.dart`:

```dart
import 'dart:typed_data';

/// Parsed 508-byte raw binary BLE packet from the ESP32 ADS1292R ECG device.
class EcgPacket {
  final int seq;
  final int sampleRate;
  final bool leadsOff;
  final bool loPlusOff;
  final bool loMinusOff;
  final int severity;         // 0=INFO, 1=WARNING, 2=CRITICAL
  final int numSamples;
  final List<int> samples;    // raw signed int32 ADC values

  const EcgPacket({
    required this.seq,
    required this.sampleRate,
    required this.leadsOff,
    required this.loPlusOff,
    required this.loMinusOff,
    required this.severity,
    required this.numSamples,
    required this.samples,
  });

  String get severityLabel {
    switch (severity) {
      case 2:  return 'CRITICAL';
      case 1:  return 'WARNING';
      default: return 'NORMAL';
    }
  }

  /// Parse raw bytes received from BLE notification.
  factory EcgPacket.fromBytes(List<int> data) {
    if (data.length < 8) {
      throw const FormatException('BLE packet too short (< 8 bytes)');
    }

    final bytes = data is Uint8List ? data : Uint8List.fromList(data);
    final bd    = ByteData.sublistView(bytes);

    final seq        = bd.getUint32(0, Endian.little);
    final sampleRate = bd.getUint8(4);
    final flags      = bd.getUint8(5);
    final severity   = bd.getUint8(6);
    final numSamples = bd.getUint8(7);

    final leadsOff   = (flags & 0x01) != 0;
    final loPlusOff  = (flags & 0x02) != 0;
    final loMinusOff = (flags & 0x04) != 0;

    final maxSamples = ((data.length - 8) ~/ 4).clamp(0, numSamples);
    final samples = <int>[
      for (int i = 0; i < maxSamples; i++)
        bd.getInt32(8 + i * 4, Endian.little),
    ];

    return EcgPacket(
      seq: seq,
      sampleRate: sampleRate,
      leadsOff: leadsOff,
      loPlusOff: loPlusOff,
      loMinusOff: loMinusOff,
      severity: severity,
      numSamples: numSamples,
      samples: samples,
    );
  }
}
```

---

## 5. BLE Service

Create `lib/services/ble_service.dart`:

```dart
import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import '../models/ecg_packet.dart';

class BleService {
  static const String _deviceName  = 'ECG_Setup';
  static const String _serviceUuid = '12345678-1234-5678-1234-56789abcdef0';
  static const String _charUuid    = '12345678-1234-5678-1234-56789abcdef1';

  BluetoothDevice?         _device;
  BluetoothCharacteristic? _char;
  StreamSubscription?      _notifySub;

  final _packetCtrl = StreamController<EcgPacket>.broadcast();
  Stream<EcgPacket> get packetStream => _packetCtrl.stream;

  bool get isConnected => _device?.isConnected ?? false;

  Future<void> scanAndConnect() async {
    await FlutterBluePlus.startScan(
      withNames: [_deviceName],
      timeout: const Duration(seconds: 10),
    );

    final results = await FlutterBluePlus.scanResults
        .firstWhere((r) => r.any((e) => e.device.advName == _deviceName));

    await FlutterBluePlus.stopScan();

    _device = results.firstWhere((r) => r.device.advName == _deviceName).device;
    await _device!.connect(autoConnect: false, mtu: 517);

    final services = await _device!.discoverServices();
    for (final svc in services) {
      if (svc.uuid.toString().toLowerCase() == _serviceUuid) {
        for (final c in svc.characteristics) {
          if (c.uuid.toString().toLowerCase() == _charUuid) {
            _char = c;
          }
        }
      }
    }

    if (_char == null) throw Exception('ECG characteristic not found!');

    await _char!.setNotifyValue(true);
    _notifySub = _char!.lastValueStream.listen(_onData);
  }

  void _onData(List<int> data) {
    if (data.isEmpty) return;
    try {
      _packetCtrl.add(EcgPacket.fromBytes(data));
    } catch (e) {
      debugPrint('[BLE] Parse error: $e');
    }
  }

  Future<void> disconnect() async {
    await _notifySub?.cancel();
    await _char?.setNotifyValue(false);
    await _device?.disconnect();
    _device = null;
    _char   = null;
  }

  void dispose() {
    _notifySub?.cancel();
    _packetCtrl.close();
  }
}
```

---

## 6. ECG Graph Widget

Create `lib/widgets/ecg_graph.dart`:

```dart
import 'dart:math' show min, max;
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

class EcgGraph extends StatelessWidget {
  final List<double> samples;
  final bool leadsOff;

  const EcgGraph({super.key, required this.samples, this.leadsOff = false});

  @override
  Widget build(BuildContext context) {
    if (leadsOff) {
      return Container(
        color: Colors.black,
        child: const Center(
          child: Text(
            'LEADS OFF\nCheck electrodes',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.orangeAccent, fontSize: 16),
          ),
        ),
      );
    }

    if (samples.isEmpty) {
      return const ColoredBox(color: Colors.black);
    }

    final minY = samples.reduce(min) - 0.05;
    final maxY = samples.reduce(max) + 0.05;

    return Container(
      color: Colors.black,
      padding: const EdgeInsets.all(8),
      child: LineChart(
        LineChartData(
          backgroundColor: Colors.black,
          gridData: const FlGridData(show: false),
          borderData: FlBorderData(show: false),
          titlesData: const FlTitlesData(show: false),
          lineTouchData: const LineTouchData(enabled: false),
          minX: 0, maxX: samples.length.toDouble(),
          minY: minY, maxY: maxY,
          lineBarsData: [
            LineChartBarData(
              spots: [
                for (int i = 0; i < samples.length; i++)
                  FlSpot(i.toDouble(), samples[i]),
              ],
              isCurved: false,
              color: const Color(0xFF00FF88),
              barWidth: 1.5,
              dotData: const FlDotData(show: false),
            ),
          ],
        ),
      ),
    );
  }
}
```

---

## 7. Full Screen

Create `lib/screens/ecg_screen.dart`:

```dart
import 'dart:math' show min, max;
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/ble_service.dart';
import '../models/ecg_packet.dart';
import '../widgets/ecg_graph.dart';

class EcgScreen extends StatefulWidget {
  const EcgScreen({super.key});

  @override
  State<EcgScreen> createState() => _EcgScreenState();
}

class _EcgScreenState extends State<EcgScreen> {
  final _ble = BleService();

  // Rolling display buffer — last 750 samples (6 seconds at 125 SPS)
  final List<double> _buf = [];
  static const int _maxBuf = 750;

  bool   _connected  = false;
  bool   _connecting = false;
  bool   _leadsOff   = false;
  String _severity   = 'NORMAL';
  int    _seq        = 0;
  String _error      = '';

  @override
  void initState() {
    super.initState();
    _ble.packetStream.listen(_onPacket);
  }

  void _onPacket(EcgPacket pkt) {
    setState(() {
      _seq      = pkt.seq;
      _leadsOff = pkt.leadsOff;
      _severity = pkt.severityLabel;

      // Normalize to ±1.0 range for display
      // ADS1292R full scale = ±8,388,607 counts at gain=6
      final norm = pkt.samples.map((s) => s / 8388607.0).toList();
      _buf.addAll(norm);
      if (_buf.length > _maxBuf) {
        _buf.removeRange(0, _buf.length - _maxBuf);
      }
    });
  }

  Future<void> _connect() async {
    setState(() { _connecting = true; _error = ''; });

    final granted = await [
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
      Permission.locationWhenInUse,
    ].request();

    if (granted.values.any((s) => s.isDenied)) {
      setState(() { _error = 'Bluetooth permissions denied.'; _connecting = false; });
      return;
    }

    try {
      await _ble.scanAndConnect();
      setState(() { _connected = true; _connecting = false; });
    } catch (e) {
      setState(() { _error = e.toString(); _connecting = false; });
    }
  }

  Future<void> _disconnect() async {
    await _ble.disconnect();
    setState(() { _connected = false; _buf.clear(); });
  }

  @override
  void dispose() {
    _ble.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: const Color(0xFF111111),
        title: const Text('ECG Monitor', style: TextStyle(color: Colors.white)),
        actions: [
          if (_connected)
            IconButton(
              icon: const Icon(Icons.bluetooth_disabled, color: Colors.redAccent),
              onPressed: _disconnect,
              tooltip: 'Disconnect',
            ),
        ],
      ),
      body: Column(
        children: [
          // Status bar
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: const Color(0xFF111111),
            child: Row(children: [
              _Dot(on: _connected),
              const SizedBox(width: 8),
              Text(
                _connected ? 'BLE Connected' : 'Disconnected',
                style: TextStyle(
                  color: _connected ? const Color(0xFF00FF88) : Colors.grey,
                  fontSize: 12, fontWeight: FontWeight.bold,
                ),
              ),
              const Spacer(),
              if (_connected) ...[
                if (_leadsOff)
                  const Text('LEADS OFF  ',
                      style: TextStyle(color: Colors.orange, fontSize: 12)),
                _SeverityBadge(severity: _severity),
                const SizedBox(width: 8),
                Text('seq: $_seq',
                    style: const TextStyle(color: Colors.white38, fontSize: 10)),
              ],
            ]),
          ),

          // ECG graph
          Expanded(
            child: _buf.isEmpty
                ? const Center(
                    child: Text('Connect to the ECG device to start monitoring.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.white38)))
                : EcgGraph(samples: List<double>.from(_buf), leadsOff: _leadsOff),
          ),

          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text(_error, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),

          if (!_connected)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              child: SizedBox(
                width: double.infinity, height: 52,
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00FF88),
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                  onPressed: _connecting ? null : _connect,
                  icon: _connecting
                      ? const SizedBox(width: 18, height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                      : const Icon(Icons.bluetooth),
                  label: Text(_connecting ? 'Scanning for ECG_Setup...' : 'Connect to ECG Device'),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  final bool on;
  const _Dot({required this.on});

  @override
  Widget build(BuildContext context) => Container(
    width: 10, height: 10,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: on ? const Color(0xFF00FF88) : Colors.grey,
      boxShadow: on
          ? [BoxShadow(color: const Color(0xFF00FF88).withOpacity(0.6), blurRadius: 6)]
          : null,
    ),
  );
}

class _SeverityBadge extends StatelessWidget {
  final String severity;
  const _SeverityBadge({required this.severity});

  Color get color {
    switch (severity) {
      case 'CRITICAL': return Colors.red;
      case 'WARNING':  return Colors.orange;
      default:         return const Color(0xFF00FF88);
    }
  }

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withOpacity(0.15),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: color.withOpacity(0.5)),
    ),
    child: Text(severity,
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold)),
  );
}
```

---

## 8. `main.dart`

```dart
import 'package:flutter/material.dart';
import 'screens/ecg_screen.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ECG Monitor',
      theme: ThemeData.dark(),
      home: const EcgScreen(),
    );
  }
}
```

---

## 9. Sample Normalization Reference

```dart
// Normalize to ±1.0 for graphing
double normalize(int raw) => raw / 8388607.0;

// Convert to millivolts (gain=6, VREF=2.42V)
double toMillivolts(int raw) => (raw / 8388607.0) * (2420.0 / 6.0); // mV
```

| Raw Value | Meaning |
|---|---|
| `±8,388,607` | Full scale (hardware max) |
| `±20,000–40,000` | Typical ECG QRS peak |
| `0` | Leads off (no signal) |

---

## 10. Project Structure

```
lib/
├── main.dart
├── models/
│   └── ecg_packet.dart     ← 508-byte binary parser
├── services/
│   └── ble_service.dart    ← Scan, connect, subscribe
├── widgets/
│   └── ecg_graph.dart      ← fl_chart ECG line graph
└── screens/
    └── ecg_screen.dart     ← Main UI
```

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| Device not found | Ensure ESP32 is on, device name is `ECG_Setup` |
| No notifications received | Call `setNotifyValue(true)` after `discoverServices()` |
| Packet length != 508 | Small MTU phone — partial packet still parsed correctly |
| All samples = 0 | `leadsOff` flag is set — fix electrodes |
| iOS permissions error | Add both keys to `Info.plist` |
| Android scan fails | Request `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` at runtime |

---

## 12. Quick Test with nRF Connect

Before building the Flutter app, verify data arrives:

1. Open **nRF Connect** (Android/iOS)
2. Scan → connect to `ECG_Setup`
3. Open service `12345678-1234-5678-1234-56789abcdef0`
4. Tap the 🔔 subscribe button on characteristic `...def1`
5. You should see **508-byte packets** arriving every ~1 second
6. First 8 bytes = header, next 500 bytes = ECG samples

---

## 13. WiFi Config Success + Status Characteristic

The ESP32 now has a **second BLE characteristic** for push notifications:

| Characteristic | UUID | Purpose |
|---|---|---|
| ECG Data | `...abcdef1` | Raw 508-byte binary ECG packets |
| **Status** | `...abcdef2` | **Plain JSON status strings** |

### Status Messages from ESP32

```json
{"status":"ble_connected"}                              // sent immediately on BLE connect
{"status":"wifi_connecting"}                            // sent when /wifi-config POST received
{"status":"wifi_connected","ip":"192.168.1.10","deviceId":"ESP_ECG_123","userId":"ESP_ECG_123"}
{"status":"wifi_failed"}                               // wrong password or network unreachable
{"status":"wifi_disconnected"}                          // WiFi STA dropped
```

### Subscribe in Flutter (add to BleService)

```dart
static const String statusCharUuid = '12345678-1234-5678-1234-56789abcdef2';

BluetoothCharacteristic? _statusChar;
final _statusCtrl = StreamController<Map<String, dynamic>>.broadcast();
Stream<Map<String, dynamic>> get statusStream => _statusCtrl.stream;

// In scanAndConnect(), after finding ECG char:
for (final c in svc.characteristics) {
  if (c.uuid.toString().toLowerCase() == ecgCharUuid)    _char       = c;
  if (c.uuid.toString().toLowerCase() == statusCharUuid) _statusChar = c;
}

// Subscribe to status notifications:
if (_statusChar != null) {
  await _statusChar!.setNotifyValue(true);
  _statusChar!.lastValueStream.listen((data) {
    if (data.isEmpty) return;
    try {
      final json = jsonDecode(String.fromCharCodes(data)) as Map<String, dynamic>;
      _statusCtrl.add(json);
    } catch (_) {}
  });
}
```

### React to WiFi Config Result in UI

```dart
// In your EcgScreen initState():
_ble.statusStream.listen((status) {
  switch (status['status']) {
    case 'wifi_connected':
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('WiFi Connected! IP: ${status['ip']}'),
          backgroundColor: Colors.green,
        ),
      );
      break;
    case 'wifi_failed':
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('WiFi connection failed. Check credentials.'),
          backgroundColor: Colors.red,
        ),
      );
      break;
    case 'wifi_connecting':
      // show a loading indicator
      break;
    case 'wifi_disconnected':
      // WiFi dropped on the device
      break;
  }
});
```

### Auto-Reconnect

BLE auto-reconnect works because:
1. ESP32 uses **bonding** (`setSecurityAuth(true, ...)`) — phone stores keys
2. ESP32 **restarts advertising immediately** on disconnect (`onDisconnect` → `startAdvertising()`)
3. iOS/Android automatically reconnect to bonded devices that are advertising

On Flutter side, listen to `FlutterBluePlus.adapterState` and call `scanAndConnect()` again when BLE comes back up.

---

## 14. WiFi Status Notification (Without BLE) — Local HTTP Server

When the device connects to WiFi (from saved credentials on boot, OR after app config), it **immediately calls back the phone** over the same WiFi network:

```
ESP32  ──GET──►  http://<phone-gateway-ip>:9000/device-status?connected=true&deviceId=...&ip=...
ESP32  ──GET──►  http://<phone-gateway-ip>:9000/heartbeat?deviceId=...   (every 5 seconds)
```

Your Flutter app must run a **local HTTP server on port 9000** to receive these.

### Add Local HTTP Server (Flutter)

#### `pubspec.yaml`
```yaml
dependencies:
  shelf: ^1.4.1
  shelf_router: ^1.1.4
```

#### `lib/services/local_server.dart`
```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;
import 'package:shelf_router/shelf_router.dart';

class LocalServer {
  static const int port = 9000;
  HttpServer? _server;

  // Events the rest of the app can listen to
  final _deviceStatusCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _heartbeatCtrl    = StreamController<String>.broadcast();

  Stream<Map<String, dynamic>> get deviceStatusStream => _deviceStatusCtrl.stream;
  Stream<String>               get heartbeatStream    => _heartbeatCtrl.stream;

  Future<void> start() async {
    final router = Router();

    // /device-status?connected=true&deviceId=...&ip=...
    router.get('/device-status', (Request req) {
      final params    = req.url.queryParameters;
      final connected = params['connected'] == 'true';
      final deviceId  = params['deviceId'] ?? '';
      final ip        = params['ip'] ?? '';
      _deviceStatusCtrl.add({
        'connected': connected,
        'deviceId':  deviceId,
        'ip':        ip,
      });
      return Response.ok('OK');
    });

    // /heartbeat?deviceId=...
    router.get('/heartbeat', (Request req) {
      final deviceId = req.url.queryParameters['deviceId'] ?? '';
      _heartbeatCtrl.add(deviceId);
      return Response.ok('OK');
    });

    _server = await io.serve(router, InternetAddress.anyIPv4, port);
    debugPrint('[LocalServer] Listening on port $port');
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }

  void dispose() {
    _deviceStatusCtrl.close();
    _heartbeatCtrl.close();
  }
}
```

#### Use in EcgScreen

```dart
final _localServer = LocalServer();

@override
void initState() {
  super.initState();

  // Start local HTTP server to receive WiFi callbacks from ESP32
  _localServer.start();

  // Listen for WiFi device-status events from ESP32 (works even without BLE)
  _localServer.deviceStatusStream.listen((event) {
    final connected = event['connected'] as bool;
    final ip        = event['ip'] as String;
    setState(() => _severity = connected ? 'NORMAL' : 'NORMAL');

    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(connected
          ? '✅ Device connected to WiFi  IP: $ip'
          : '❌ Device disconnected from WiFi'),
      backgroundColor: connected ? Colors.green : Colors.orange,
      duration: const Duration(seconds: 4),
    ));
  });

  // Heartbeat — update "last seen" timestamp
  _localServer.heartbeatStream.listen((deviceId) {
    setState(() => _lastSeen = DateTime.now());
  });

  // BLE packet stream (ECG data)
  _ble.packetStream.listen(_onPacket);

  // BLE status stream (wifi_connected, wifi_failed, etc.)
  _ble.statusStream.listen(_onBleStatus);
}

@override
void dispose() {
  _localServer.dispose();
  _ble.dispose();
  super.dispose();
}
```

### Complete Notification Matrix

| Scenario | How app is notified |
|---|---|
| App sends WiFi config over BLE | BLE Status char push: `{"status":"wifi_connecting"}` |
| WiFi connects OK (via BLE config) | BLE Status char push: `{"status":"wifi_connected","ip":"..."}` **AND** HTTP GET `/device-status?connected=true` |
| WiFi connects OK (saved creds at boot) | HTTP GET `/device-status?connected=true` (no BLE needed) |
| WiFi wrong password | BLE Status char push: `{"status":"wifi_failed"}` |
| WiFi drops | BLE push `{"status":"wifi_disconnected"}` **AND** HTTP GET `/device-status?connected=false` |
| Device alive and connected | HTTP GET `/heartbeat` every 5 seconds |

### Phone Gateway IP

| Phone type | Hotspot gateway IP |
|---|---|
| Android hotspot | `192.168.43.1` |
| iPhone hotspot | `172.20.10.1` |
| Home router | Varies — ESP32 uses `WiFi.gatewayIP()` automatically |

> The ESP32 calls `WiFi.gatewayIP()` to get the right IP automatically — no hardcoding needed.

### Android: Allow Local HTTP Server

Add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.INTERNET" />
```

For Android 9+ (cleartext HTTP), add to `<application>`:
```xml
android:usesCleartextTraffic="true"
```

### iOS: Allow Local HTTP Server

Add to `ios/Runner/Info.plist`:
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```
