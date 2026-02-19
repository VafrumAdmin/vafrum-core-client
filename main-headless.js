#!/usr/bin/env node
/**
 * Vafrum Core - Headless Bridge (Raspberry Pi / Linux Server)
 * Keine GUI, kein Electron - nur MQTT + Socket.IO + Kamera-Streaming
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const tls = require('tls');
const express = require('express');

// === Config ===
const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOGS_DIR = path.join(__dirname, 'logs');
const API_URL = 'https://vafrum-core.de';
const MJPEG_PORT = 8765;

// Plattform-spezifische Binary-Namen
const BIN_EXT = process.platform === 'win32' ? '.exe' : '';
const GO2RTC_BIN = 'go2rtc' + BIN_EXT;
const CLOUDFLARED_BIN = 'cloudflared' + BIN_EXT;

// === State ===
let apiSocket = null;
let mqttClients = new Map();
let printers = new Map();
let config = { apiKey: '' };
let go2rtcProcess = null;
let go2rtcReady = false;
let go2rtcIntentionalKill = false;
let go2rtcRestartTimer = null;
let go2rtcWatchdogTimer = null;
let tunnelProcess = null;
let tunnelRestartAttempts = 0;
let tunnelRestartTimer = null;
let cameraUrls = new Map();
let cameraStreams = new Map();
let jpegStreams = new Map();
let mjpegServer = null;
let pendingStreams = [];
let localIp = 'localhost';
let rawMqttLogStream = null;
let mqttErrorThrottle = new Map();
let printerReconnectTimers = new Map();
let printerDataCache = new Map();
let reconnectAttempts = new Map();
let isQuitting = false;

// === Logging ===
function sendLog(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log('[' + ts + '] ' + msg);
}

function initLogging() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const rawLogPath = path.join(LOGS_DIR, 'mqtt-raw.log');
  rawMqttLogStream = fs.createWriteStream(rawLogPath, { flags: 'a' });
  sendLog('Logging initialisiert: ' + LOGS_DIR);
}

function logRawMqtt(serialNumber, topic, data) {
  if (!rawMqttLogStream) return;
  const timestamp = new Date().toISOString();
  const entry = '[' + timestamp + '] [' + serialNumber + '] ' + topic + '\n' + JSON.stringify(data, null, 2) + '\n' + '='.repeat(80) + '\n';
  rawMqttLogStream.write(entry);
}

function logLatestStatus() {
  const statusObj = {};
  printers.forEach((printer, serial) => { statusObj[serial] = printer; });
  try {
    fs.writeFileSync(path.join(LOGS_DIR, 'latest-status.json'), JSON.stringify(statusObj, null, 2));
  } catch (e) {}
}

// === Config ===
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config.apiKey = loaded.apiKey || '';
      config.tunnelUrl = loaded.tunnelUrl || '';
    }
  } catch (e) {
    sendLog('Config Fehler: ' + e.message);
  }
}

function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    sendLog('Config Speicherfehler: ' + e.message);
  }
}

// === API Verbindung ===
function connectToApi(apiKey) {
  if (apiSocket) apiSocket.disconnect();

  sendLog('Verbinde mit ' + API_URL + '...');
  apiSocket = io(API_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    timeout: 20000,
    auth: { apiKey }
  });

  apiSocket.on('connect', () => sendLog('API verbunden'));
  apiSocket.on('authenticated', () => {
    sendLog('Authentifiziert');
    apiSocket.emit('printers:request');
  });
  apiSocket.on('auth:error', (error) => sendLog('Auth Fehler: ' + error));

  apiSocket.on('printers:list', (list) => {
    sendLog(list.length + ' Drucker empfangen');
    list.forEach(p => {
      sendLog('Drucker: ' + p.name + ' | Model: ' + (p.model || '?') + ' | SN: ' + p.serialNumber);
      if (p.serialNumber && p.ipAddress && p.accessCode) connectPrinter(p);
    });
  });

  apiSocket.on('printer:add', (p) => {
    sendLog('Neuer Drucker: ' + p.name);
    if (p.serialNumber && p.ipAddress && p.accessCode) connectPrinter(p);
  });

  apiSocket.on('printer:remove', (data) => {
    sendLog('Drucker entfernt: ' + data.serialNumber);
    const client = mqttClients.get(data.serialNumber);
    if (client) {
      client.end();
      mqttClients.delete(data.serialNumber);
      printers.delete(data.serialNumber);
      cameraUrls.delete(data.serialNumber);
      cameraStreams.delete('cam_' + data.serialNumber);
      stopJpegStream(data.serialNumber);
    }
  });

  apiSocket.on('printer:command', (data) => {
    sendLog('Befehl: ' + JSON.stringify(data.command) + ' für ' + data.serialNumber);
    executeCommand(data.serialNumber, data.command);
  });

  apiSocket.on('disconnect', () => sendLog('API getrennt'));
}

function disconnectApi() {
  if (apiSocket) { apiSocket.disconnect(); apiSocket = null; }
  mqttClients.forEach(c => c.end());
  mqttClients.clear();
  printers.clear();
}

// === Drucker MQTT ===
function connectPrinter(printer) {
  if (mqttClients.has(printer.serialNumber)) return;
  printerDataCache.set(printer.serialNumber, printer);

  if (printerReconnectTimers.has(printer.serialNumber)) {
    clearTimeout(printerReconnectTimers.get(printer.serialNumber));
    printerReconnectTimers.delete(printer.serialNumber);
  }

  sendLog('Verbinde: ' + printer.name);
  const client = mqtt.connect('mqtts://' + printer.ipAddress + ':8883', {
    username: 'bblp',
    password: printer.accessCode,
    rejectUnauthorized: false,
    clientId: 'vafrum_' + printer.serialNumber + '_' + Date.now(),
    connectTimeout: 15000,
    reconnectPeriod: 0
  });

  client.on('connect', () => {
    sendLog('Drucker verbunden: ' + printer.name);
    mqttClients.set(printer.serialNumber, client);
    printers.set(printer.serialNumber, { ...printer, online: true });
    reconnectAttempts.delete(printer.serialNumber);
    mqttErrorThrottle.delete(printer.serialNumber);
    client.subscribe('device/' + printer.serialNumber + '/report');
    const reqTopic = 'device/' + printer.serialNumber + '/request';
    client.publish(reqTopic, JSON.stringify({ info: { sequence_id: '0', command: 'get_version' } }));
    client.publish(reqTopic, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
    addCameraStream(printer.serialNumber, printer.accessCode, printer.ipAddress, printer.model);
  });

  client.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      logRawMqtt(printer.serialNumber, topic, data);

      // H2D/H2C: Kammertemperatur via CTC-Modul
      const ctcTemp = data.print?.device?.ctc?.info?.temp;
      if (ctcTemp !== undefined && ctcTemp !== null) {
        const ctcValue = ctcTemp & 0xFFFF;
        const prev = printers.get(printer.serialNumber) || {};
        prev.chamberTemp = ctcValue;
        printers.set(printer.serialNumber, prev);
      }

      if (data.print) {
        const p = data.print;
        const prevStatus = printers.get(printer.serialNumber) || {};
        const isH2 = prevStatus.model?.toUpperCase()?.includes('H2');

        // AMS parsing
        let ams = null;
        if (p.ams) {
          const prevAms = prevStatus.ams || { units: [], trays: [] };
          ams = { humidity: p.ams.ams_humidity ?? prevAms.humidity, trayNow: p.ams.tray_now ?? prevAms.trayNow, units: prevAms.units || [], trays: prevAms.trays || [] };
          if (Array.isArray(p.ams.ams)) {
            ams.units = []; ams.trays = [];
            p.ams.ams.forEach((unit, unitIdx) => {
              const hasHumidityRaw = unit.humidity_raw !== undefined && unit.humidity_raw !== '';
              const hasHumidityIndex = unit.humidity !== undefined && unit.humidity !== '' && parseInt(unit.humidity) > 0;
              const unitData = { id: unitIdx, temp: parseFloat(unit.temp) || 0 };
              if (hasHumidityRaw) { unitData.humidity = parseInt(unit.humidity_raw); unitData.humidityIndex = parseInt(unit.humidity) || 0; }
              else if (hasHumidityIndex) { unitData.humidity = parseInt(unit.humidity); unitData.humidityIndex = parseInt(unit.humidity); }
              ams.units.push(unitData);
              if (Array.isArray(unit.tray)) {
                unit.tray.forEach((tray, trayIdx) => {
                  const hasData = tray && (tray.tray_type || (tray.tray_color && tray.tray_color !== '00000000'));
                  if (hasData) {
                    ams.trays.push({
                      id: unitIdx * 4 + trayIdx, unitId: unitIdx, slot: trayIdx,
                      type: tray.tray_type || '', color: tray.tray_color || '',
                      name: tray.tray_sub_brands || tray.tray_type || '',
                      remain: tray.remain != null ? parseInt(tray.remain) : -1,
                      k: tray.k || 0, nozzleTempMin: tray.nozzle_temp_min || 0, nozzleTempMax: tray.nozzle_temp_max || 0,
                      trayInfoIdx: tray.tray_info_idx || '', tagUid: tray.tag_uid || '', trayUuid: tray.tray_uuid || '',
                      trayWeight: tray.tray_weight ? parseInt(tray.tray_weight) : 0,
                      dryingTemp: tray.drying_temp ? parseInt(tray.drying_temp) : 0,
                      dryingTime: tray.drying_time ? parseInt(tray.drying_time) : 0
                    });
                  }
                });
              }
            });
          }
        }

        // External spool
        let externalSpool = null;
        let externalSpools = [];
        if (Array.isArray(p.vir_slot) && p.vir_slot.length > 0) {
          for (const slot of p.vir_slot) {
            const vtType = slot.tray_type || '';
            const vtColor = slot.tray_color || '';
            if (vtType || (vtColor && vtColor !== '00000000')) {
              const spoolData = {
                id: slot.id != null ? parseInt(slot.id) : 254, type: vtType, color: vtColor,
                name: slot.tray_sub_brands || '', remain: slot.remain != null ? parseInt(slot.remain) : -1,
                k: slot.k || 0, nozzleTempMin: slot.nozzle_temp_min || 0, nozzleTempMax: slot.nozzle_temp_max || 0,
                trayInfoIdx: slot.tray_info_idx || '', tagUid: slot.tag_uid || '',
                trayWeight: slot.tray_weight ? parseInt(slot.tray_weight) : 0
              };
              externalSpools.push(spoolData);
              if (!externalSpool) externalSpool = spoolData;
            }
          }
        } else if (p.vt_tray) {
          const vtType = p.vt_tray.tray_type || '';
          const vtColor = p.vt_tray.tray_color || '';
          if (vtType || (vtColor && vtColor !== '00000000')) {
            externalSpool = {
              type: vtType, color: vtColor, name: p.vt_tray.tray_sub_brands || '',
              remain: p.vt_tray.remain != null ? parseInt(p.vt_tray.remain) : -1,
              k: p.vt_tray.k || 0, nozzleTempMin: p.vt_tray.nozzle_temp_min || 0, nozzleTempMax: p.vt_tray.nozzle_temp_max || 0,
              trayInfoIdx: p.vt_tray.tray_info_idx || '', tagUid: p.vt_tray.tag_uid || '',
              trayWeight: p.vt_tray.tray_weight ? parseInt(p.vt_tray.tray_weight) : 0
            };
            externalSpools = [externalSpool];
          }
        }

        // Stale-Data Fix
        const currentState = p.gcode_state ?? prevStatus.gcodeState;
        if (currentState === 'IDLE' || currentState === 'FINISH') {
          if (p.print_error === undefined || p.print_error === null || p.print_error === 0) {
            prevStatus.printError = 0; prevStatus.printErrorCode = '';
          }
          prevStatus.printProgress = 0; prevStatus.remainingTime = 0;
          prevStatus.nozzleTargetTemp = 0; prevStatus.nozzleTargetTemp2 = 0; prevStatus.bedTargetTemp = 0;
          prevStatus.hms = [];
        }

        const prevState = prevStatus.gcodeState;
        const wasPrinting = prevState === 'RUNNING' || prevState === 'PAUSE' || prevState === 'PREPARE';
        const nowIdle = currentState === 'IDLE' || currentState === 'FINISH';
        if (wasPrinting && nowIdle) {
          prevStatus.nozzleTemp = 0; prevStatus.nozzleTemp2 = undefined;
          prevStatus.bedTemp = 0; prevStatus.chamberTemp = 0;
        }

        const decodeTemp = (encoded) => {
          if (encoded === undefined || encoded === null || encoded === 0) return { current: 0, target: 0 };
          return { current: encoded & 0xFFFF, target: (encoded >> 16) & 0xFFFF };
        };

        const isH2Model = isH2;
        let nozzle1Temp = isH2Model ? (prevStatus.nozzleTemp ?? 0) : (p.nozzle_temper ?? prevStatus.nozzleTemp ?? 0);
        let nozzle1Target = isH2Model ? (prevStatus.nozzleTargetTemp ?? 0) : (p.nozzle_target_temper ?? prevStatus.nozzleTargetTemp ?? 0);
        let nozzle2Temp = isH2Model ? (prevStatus.nozzleTemp2) : (p.nozzle_temper_2 ?? prevStatus.nozzleTemp2);
        let nozzle2Target = isH2Model ? (prevStatus.nozzleTargetTemp2) : (p.nozzle_target_temper_2 ?? prevStatus.nozzleTargetTemp2);

        const deviceExtruder = p.device?.extruder?.info;
        if (Array.isArray(deviceExtruder) && deviceExtruder.length >= 1) {
          const left = decodeTemp(deviceExtruder[0]?.temp);
          nozzle1Temp = left.current; nozzle1Target = left.target;
          if (deviceExtruder.length >= 2) {
            const right = decodeTemp(deviceExtruder[1]?.temp);
            nozzle2Temp = right.current; nozzle2Target = right.target;
          }
        } else if (p.extruder && Array.isArray(p.extruder.info) && p.extruder.info.length >= 2) {
          const left = decodeTemp(p.extruder.info[0]?.temp);
          const right = decodeTemp(p.extruder.info[1]?.temp);
          nozzle1Temp = left.current; nozzle1Target = left.target;
          nozzle2Temp = right.current; nozzle2Target = right.target;
        }

        const chamberTempValue = p.chamber_temper ?? (isH2Model ? p.info?.temp : undefined);

        const status = {
          online: true,
          gcodeState: p.gcode_state ?? prevStatus.gcodeState ?? 'IDLE',
          printProgress: p.mc_percent ?? prevStatus.printProgress ?? 0,
          remainingTime: p.mc_remaining_time ?? prevStatus.remainingTime ?? 0,
          currentFile: p.gcode_file || p.subtask_name || prevStatus.currentFile || '',
          layer: p.layer_num ?? prevStatus.layer ?? 0,
          totalLayers: p.total_layer_num ?? prevStatus.totalLayers ?? 0,
          nozzleTemp: nozzle1Temp, nozzleTargetTemp: nozzle1Target,
          nozzleTemp2: nozzle2Temp, nozzleTargetTemp2: nozzle2Target,
          bedTemp: p.bed_temper ?? prevStatus.bedTemp ?? 0,
          bedTargetTemp: p.bed_target_temper ?? prevStatus.bedTargetTemp ?? 0,
          chamberTemp: chamberTempValue ?? prevStatus.chamberTemp ?? 0,
          partFan: p.cooling_fan_speed ?? prevStatus.partFan,
          auxFan: p.big_fan1_speed ?? prevStatus.auxFan,
          chamberFan: p.big_fan2_speed ?? prevStatus.chamberFan,
          chamberLight: p.lights_report ? p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' : prevStatus.chamberLight,
          workLight: p.lights_report ? (
            p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' ||
            p.lights_report.find(l => l.node === 'chamber_light2')?.mode === 'on' ||
            p.lights_report.find(l => l.node === 'work_light')?.mode === 'on'
          ) : prevStatus.workLight,
          speedLevel: p.spd_lvl ?? prevStatus.speedLevel,
          speedMagnitude: p.spd_mag ?? prevStatus.speedMagnitude,
          ams: ams || prevStatus.ams,
          externalSpool: externalSpool || prevStatus.externalSpool,
          externalSpools: externalSpools.length > 0 ? externalSpools : prevStatus.externalSpools,
          wifiSignal: p.wifi_signal ?? prevStatus.wifiSignal,
          printType: p.print_type ?? prevStatus.printType,
          printError: p.print_error ?? prevStatus.printError ?? 0,
          printErrorCode: p.mc_print_error_code ?? prevStatus.printErrorCode ?? '',
          printStage: p.mc_print_stage ?? prevStatus.printStage,
          hms: Array.isArray(p.hms) ? p.hms : (prevStatus.hms || []),
          _h2debug: isH2 ? {
            printKeys: Object.keys(p).join(','),
            device: p.device ? JSON.stringify(p.device).substring(0, 800) : undefined
          } : undefined
        };

        printers.set(printer.serialNumber, { ...printers.get(printer.serialNumber), ...status });
        logLatestStatus();

        if (apiSocket?.connected) {
          apiSocket.emit('printer:status', {
            printerId: printer.id, serialNumber: printer.serialNumber,
            ...status, cameraUrl: cameraUrls.get(printer.serialNumber) || undefined
          });
        }
      }
    } catch (e) {}
  });

  client.on('error', (err) => {
    const now = Date.now();
    const lastLog = mqttErrorThrottle.get(printer.serialNumber) || 0;
    if (now - lastLog > 60000) {
      sendLog('Fehler ' + printer.name + ': ' + err.message);
      mqttErrorThrottle.set(printer.serialNumber, now);
    }
  });

  client.on('close', () => {
    mqttClients.delete(printer.serialNumber);
    const pr = printers.get(printer.serialNumber);
    if (pr) {
      printers.set(printer.serialNumber, { ...pr, online: false });
      if (apiSocket?.connected) {
        apiSocket.emit('printer:status', { printerId: printer.id, serialNumber: printer.serialNumber, online: false });
      }
    }
    scheduleReconnect(printer.serialNumber);
  });
}

function scheduleReconnect(serialNumber) {
  const cached = printerDataCache.get(serialNumber);
  if (!cached || mqttClients.has(serialNumber)) return;

  const attempts = reconnectAttempts.get(serialNumber) || 0;
  const delay = Math.min(5000 * Math.pow(2, attempts), 120000);

  reconnectAttempts.set(serialNumber, attempts + 1);
  if (attempts === 0 || attempts % 5 === 0) {
    sendLog('Reconnect ' + cached.name + ' in ' + Math.round(delay / 1000) + 's (Versuch ' + (attempts + 1) + ')');
  }

  const timer = setTimeout(() => {
    printerReconnectTimers.delete(serialNumber);
    if (!mqttClients.has(serialNumber)) connectPrinter(cached);
  }, delay);
  printerReconnectTimers.set(serialNumber, timer);
}

// === Befehle ===
function executeCommand(serialNumber, command) {
  const client = mqttClients.get(serialNumber);
  if (!client) { sendLog('Kein MQTT Client für ' + serialNumber); return; }

  const topic = 'device/' + serialNumber + '/request';
  const cmd = typeof command === 'string' ? { type: command } : command;
  let payload = {};

  switch (cmd.type) {
    case 'pause': payload = { print: { command: 'pause', sequence_id: '0' } }; break;
    case 'resume': payload = { print: { command: 'resume', sequence_id: '0' } }; break;
    case 'stop': payload = { print: { command: 'stop', sequence_id: '0' } }; break;
    case 'chamberLight': case 'light':
      payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: cmd.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 }, user_id: '1234567890' }; break;
    case 'workLight':
      const printerWL = printers.get(serialNumber);
      const modelUpperWL = printerWL?.model?.toUpperCase() || '';
      const ledModeWL = cmd.on ? 'on' : 'off';
      if (modelUpperWL.includes('A1')) {
        client.publish(topic, JSON.stringify({ system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } }));
        client.publish(topic, JSON.stringify({ system: { sequence_id: '0', command: 'ledctrl', led_node: 'work_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } }));
        return;
      } else if (modelUpperWL.includes('H2D') || modelUpperWL.includes('H2S') || modelUpperWL.includes('H2C') || modelUpperWL.includes('X1')) {
        payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light2', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
      } else {
        payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'work_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
      }
      break;
    case 'nozzleTemp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M104 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;
    case 'nozzle2Temp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M104 T1 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;
    case 'bedTemp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M140 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;
    case 'partFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P1 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;
    case 'auxFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P2 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;
    case 'chamberFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P3 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;
    case 'speedLevel': payload = { print: { command: 'print_speed', sequence_id: '0', param: String(cmd.level) } }; break;
    case 'amsUnload': case 'unloadFilament':
      payload = { print: { command: 'ams_change_filament', sequence_id: '0', target: 255, curr_temp: 220, tar_temp: 220 } }; break;
    case 'amsLoad': case 'loadFilament':
      payload = { print: { command: 'ams_change_filament', sequence_id: '0', target: cmd.slot ?? cmd.trayId ?? 0, curr_temp: 220, tar_temp: 220 } }; break;
    case 'gcode': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: cmd.gcode + '\n' }, user_id: '1234567890' }; break;
    case 'home': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G28\n' }, user_id: '1234567890' }; break;
    case 'calibration':
      switch (cmd.calibrationType) {
        case 'home': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G28\n' }, user_id: '1234567890' }; break;
        case 'bed_level': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G29\n' }, user_id: '1234567890' }; break;
        default: return;
      }
      break;
    case 'move':
      let dist = cmd.distance || 10;
      const axis = cmd.axis || 'X';
      client.publish(topic, JSON.stringify({ print: { command: 'gcode_line', sequence_id: '2006', param: 'G91\n' }, user_id: '1234567890' }));
      client.publish(topic, JSON.stringify({ print: { command: 'gcode_line', sequence_id: '2006', param: 'G0 ' + axis + dist + ' F3000\n' }, user_id: '1234567890' }));
      payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G90\n' }, user_id: '1234567890' }; break;
    case 'amsFilamentSetting':
      const filamentCodeMap = { 'PLA': 'GFL99', 'PLA-S': 'GFL96', 'PLA-CF': 'GFL98', 'PETG': 'GFG99', 'PETG-CF': 'GFG98', 'ABS': 'GFB99', 'ASA': 'GFB98', 'TPU': 'GFU99', 'PA': 'GFN99', 'PA-CF': 'GFN98', 'PC': 'GFC99', 'PVA': 'GFS99', 'HIPS': 'GFS98' };
      const filamentCode = cmd.trayInfoIdx || filamentCodeMap[cmd.trayType] || 'GFL99';
      payload = { print: { sequence_id: '0', command: 'ams_filament_setting', ams_id: cmd.amsId, slot_id: cmd.trayId, tray_id: cmd.trayId, tray_info_idx: filamentCode, setting_id: '', tray_color: cmd.trayColor, nozzle_temp_min: cmd.nozzleTempMin, nozzle_temp_max: cmd.nozzleTempMax, tray_type: cmd.trayType } };
      client.publish(topic, JSON.stringify(payload), (err) => {
        if (err) sendLog('AMS Fehler: ' + err.message);
        else { sendLog('AMS Filament Setting gesendet'); setTimeout(() => client.publish(topic, JSON.stringify({ pushing: { command: 'pushall' } })), 2000); }
      });
      return;
    default: return;
  }

  client.publish(topic, JSON.stringify(payload), (err) => {
    if (err) sendLog('MQTT Fehler: ' + err.message);
  });
}

// === Kamera / go2rtc ===
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function isA1P1Model(model) {
  if (!model) return false;
  const m = model.toUpperCase();
  return m.includes('A1') || m.includes('P1');
}

function startMjpegServer() {
  const net = require('net');
  const expressApp = express();

  expressApp.get('/stream/:serial', (req, res) => {
    const stream = jpegStreams.get(req.params.serial);
    if (!stream) { res.status(404).send('Stream nicht gefunden'); return; }
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    stream.clients.add(res);
    if (stream.lastFrame) sendJpegFrame(res, stream.lastFrame);
    req.on('close', () => stream.clients.delete(res));
  });

  expressApp.get('/frame/:serial', (req, res) => {
    const stream = jpegStreams.get(req.params.serial);
    if (!stream || !stream.lastFrame) { res.status(404).send('Kein Frame'); return; }
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(stream.lastFrame);
  });

  expressApp.use('/api', (req, res) => {
    const proxyReq = http.request({ hostname: '127.0.0.1', port: 1984, path: '/api' + req.url, method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).send('go2rtc nicht erreichbar'));
    req.pipe(proxyReq);
  });

  expressApp.get('/stream.html', (req, res) => {
    const qs = require('url').parse(req.url).search || '';
    const proxyReq = http.request({ hostname: '127.0.0.1', port: 1984, path: '/stream.html' + qs, method: 'GET', headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).send('go2rtc nicht erreichbar'));
    proxyReq.end();
  });

  expressApp.get('/video-stream.js', (req, res) => {
    const proxyReq = http.request({ hostname: '127.0.0.1', port: 1984, path: req.url, method: 'GET', headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).send('go2rtc nicht erreichbar'));
    proxyReq.end();
  });

  mjpegServer = expressApp.listen(MJPEG_PORT, '0.0.0.0', () => {
    sendLog('Kamera-Server gestartet auf 0.0.0.0:' + MJPEG_PORT);
  });

  mjpegServer.on('upgrade', (req, socket, head) => {
    const proxySocket = net.connect(1984, '127.0.0.1', () => {
      let reqStr = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      for (let i = 0; i < req.rawHeaders.length; i += 2) reqStr += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
      reqStr += '\r\n';
      proxySocket.write(reqStr);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket); socket.pipe(proxySocket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
}

function sendJpegFrame(res, frameData) {
  try {
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frameData.length + '\r\n\r\n');
    res.write(frameData);
    res.write('\r\n');
  } catch (e) {}
}

function startJpegStream(serial, accessCode, ip) {
  if (jpegStreams.has(serial)) return;
  sendLog('Starte JPEG Stream: ' + serial);

  const streamData = { socket: null, lastFrame: null, lastFrameTime: 0, clients: new Set(), reconnectAttempts: 0, buffer: Buffer.alloc(0), watchdogTimer: null, accessCode, ip };
  jpegStreams.set(serial, streamData);

  streamData.watchdogTimer = setInterval(() => {
    if (!jpegStreams.has(serial)) { clearInterval(streamData.watchdogTimer); return; }
    const silent = Date.now() - streamData.lastFrameTime;
    if (streamData.lastFrameTime > 0 && silent > 60000 && streamData.socket) {
      sendLog('JPEG Watchdog reconnect: ' + serial);
      streamData.socket.destroy(); streamData.socket = null; streamData.buffer = Buffer.alloc(0);
      streamData.reconnectAttempts = 0;
      connectJpegStream(serial, accessCode, ip, streamData);
    }
  }, 30000);

  connectJpegStream(serial, accessCode, ip, streamData);

  const baseUrl = config.tunnelUrl || ('http://' + localIp + ':' + MJPEG_PORT);
  cameraUrls.set(serial, baseUrl + '/stream/' + serial);
}

function connectJpegStream(serial, accessCode, ip, streamData) {
  streamData.connectTime = Date.now();
  streamData.receivedData = false;

  const socket = tls.connect({ host: ip, port: 6000, rejectUnauthorized: false }, () => {
    streamData.reconnectAttempts = 0;
    const authPacket = Buffer.alloc(80);
    authPacket.writeUInt32LE(0x40, 0);
    authPacket.writeUInt32LE(0x3000, 4);
    Buffer.from('bblp').copy(authPacket, 16);
    Buffer.from(accessCode).copy(authPacket, 48);
    socket.write(authPacket);
  });

  socket.on('data', (data) => {
    streamData.receivedData = true;
    streamData.buffer = Buffer.concat([streamData.buffer, data]);
    processJpegBuffer(serial, streamData);
  });

  socket.on('error', (err) => sendLog('JPEG Fehler (' + serial + '): ' + err.message));
  socket.on('close', () => {
    streamData.socket = null;
    if (jpegStreams.has(serial)) {
      streamData.reconnectAttempts++;
      const delay = Math.min(5000 * Math.pow(1.5, Math.min(streamData.reconnectAttempts - 1, 6)), 30000);
      setTimeout(() => { if (jpegStreams.has(serial)) connectJpegStream(serial, accessCode, ip, streamData); }, delay);
    }
  });

  streamData.socket = socket;
}

function processJpegBuffer(serial, streamData) {
  const JPEG_START = Buffer.from([0xFF, 0xD8]);
  const JPEG_END = Buffer.from([0xFF, 0xD9]);
  while (true) {
    const startIdx = streamData.buffer.indexOf(JPEG_START);
    if (startIdx === -1) { streamData.buffer = Buffer.alloc(0); return; }
    if (startIdx > 0) streamData.buffer = streamData.buffer.slice(startIdx);
    const endIdx = streamData.buffer.indexOf(JPEG_END, 2);
    if (endIdx === -1) return;
    const jpegData = streamData.buffer.slice(0, endIdx + 2);
    streamData.buffer = streamData.buffer.slice(endIdx + 2);
    if (jpegData.length > 100) {
      streamData.lastFrame = jpegData;
      streamData.lastFrameTime = Date.now();
      streamData.clients.forEach(client => sendJpegFrame(client, jpegData));
    }
  }
}

function stopJpegStream(serial) {
  const stream = jpegStreams.get(serial);
  if (stream) {
    if (stream.watchdogTimer) clearInterval(stream.watchdogTimer);
    if (stream.socket) stream.socket.destroy();
    stream.clients.forEach(c => { try { c.end(); } catch (e) {} });
    jpegStreams.delete(serial);
  }
}

function startGo2rtc() {
  const locations = [
    path.join(__dirname, GO2RTC_BIN),
    path.join(__dirname, 'bin', GO2RTC_BIN)
  ];

  let go2rtcPath = null;
  for (const loc of locations) {
    if (fs.existsSync(loc)) { go2rtcPath = loc; break; }
  }

  if (!go2rtcPath) { sendLog(GO2RTC_BIN + ' nicht gefunden'); return; }
  sendLog('go2rtc gefunden: ' + go2rtcPath);

  const wwwDir = path.join(__dirname, 'www');
  if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });
  fs.writeFileSync(path.join(wwwDir, 'stream.html'), '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000;display:flex}header,nav{display:none!important}video-stream{display:block;width:100%!important;height:100%!important;flex:1 1 100%!important}video{width:100%!important;height:100%!important;object-fit:contain!important;display:block!important}</style><script type="module" src="video-stream.js"></script></head><body><script>var p=new URLSearchParams(location.search);var src=p.get("src");if(src){function init(){var v=document.createElement("video-stream");v.src=new URL("api/ws?src="+src,location.href).href;v.style.cssText="width:100%;height:100%";document.body.appendChild(v);var obs=new MutationObserver(function(){var h=document.querySelector("header");if(h)h.remove();var vid=document.querySelector("video");if(vid){vid.controls=false;obs.disconnect();}});obs.observe(document.body,{childList:true,subtree:true});}if(customElements.get("video-stream"))init();else customElements.whenDefined("video-stream").then(init);}</script></body></html>');

  const configFile = path.join(__dirname, 'go2rtc.yaml');
  fs.writeFileSync(configFile, 'api:\n  listen: "127.0.0.1:1984"\n  static_dir: "' + wwwDir.replace(/\\/g, '/') + '"\nrtsp:\n  listen: ""\nstreams: {}\n');

  go2rtcProcess = spawn(go2rtcPath, ['-c', configFile], { stdio: 'ignore', cwd: __dirname });
  go2rtcProcess.on('error', (e) => sendLog('go2rtc Fehler: ' + e.message));

  go2rtcProcess.on('close', (code) => {
    sendLog('go2rtc beendet (Code: ' + code + ')');
    go2rtcProcess = null; go2rtcReady = false;
    if (go2rtcIntentionalKill) { go2rtcIntentionalKill = false; return; }
    if (!isQuitting) {
      go2rtcWatchdogTimer = setTimeout(() => { go2rtcWatchdogTimer = null; startGo2rtc(); }, 3000);
    }
  });

  setTimeout(() => {
    go2rtcReady = true;
    sendLog('go2rtc gestartet');
    if (pendingStreams.length > 0) {
      pendingStreams.forEach(s => addCameraStream(s.serial, s.accessCode, s.ip, s.model));
      pendingStreams = [];
    }
    startTunnel();
  }, 2000);
}

function startTunnel() {
  const locations = [
    path.join(__dirname, CLOUDFLARED_BIN),
    path.join(__dirname, 'bin', CLOUDFLARED_BIN)
  ];

  let cfPath = null;
  for (const loc of locations) {
    if (fs.existsSync(loc)) { cfPath = loc; break; }
  }

  if (!cfPath) { sendLog(CLOUDFLARED_BIN + ' nicht gefunden'); return; }

  sendLog('Starte Tunnel...');
  tunnelProcess = spawn(cfPath, ['tunnel', '--url', 'http://localhost:' + MJPEG_PORT]);

  tunnelProcess.stderr.on('data', (data) => {
    const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      config.tunnelUrl = match[0];
      tunnelRestartAttempts = 0;
      sendLog('Tunnel aktiv: ' + config.tunnelUrl);
      printers.forEach((printer, serial) => {
        const isA1 = isA1P1Model(printer.model);
        const mjpegUrl = isA1 ? config.tunnelUrl + '/stream/' + serial : config.tunnelUrl + '/api/stream.mjpeg?src=cam_' + serial;
        cameraUrls.set(serial, mjpegUrl);
        if (apiSocket?.connected) {
          apiSocket.emit('printer:status', { printerId: printer.id, serialNumber: serial, cameraUrl: mjpegUrl });
        }
      });
    }
  });

  tunnelProcess.on('error', (e) => sendLog('Tunnel Fehler: ' + e.message));
  tunnelProcess.on('close', (code) => {
    tunnelProcess = null;
    const delay = Math.min(5000 * Math.pow(2, tunnelRestartAttempts), 300000);
    tunnelRestartAttempts++;
    sendLog('Tunnel Neustart in ' + Math.round(delay / 1000) + 's');
    tunnelRestartTimer = setTimeout(() => { tunnelRestartTimer = null; startTunnel(); }, delay);
  });
}

function addCameraStream(serial, accessCode, ip, model) {
  sendLog('Kamera-Setup: ' + serial + ' (' + (model || '?') + ')');
  if (isA1P1Model(model)) { startJpegStream(serial, accessCode, ip); return; }
  if (!go2rtcReady) { pendingStreams.push({ serial, accessCode, ip, model }); return; }

  const streamName = 'cam_' + serial;
  const streamUrl = 'rtspx://bblp:' + accessCode + '@' + ip + ':322/streaming/live/1';
  cameraStreams.set(streamName, streamUrl);

  const baseUrl = config.tunnelUrl || ('http://' + localIp + ':' + MJPEG_PORT);
  cameraUrls.set(serial, baseUrl + '/api/stream.mjpeg?src=' + streamName);

  const apiUrl = 'http://127.0.0.1:1984/api/streams?name=' + encodeURIComponent(streamName) + '&src=' + encodeURIComponent(streamUrl);
  const req = http.request(apiUrl, { method: 'PUT' }, (res) => {
    res.on('data', () => {});
    res.on('end', () => { if (res.statusCode === 200) sendLog('Stream hinzugefügt: ' + streamName); });
  });
  req.on('error', (e) => sendLog('Stream Fehler: ' + e.message));
  req.end();
}

// === Shutdown ===
function shutdown() {
  if (isQuitting) return;
  isQuitting = true;
  sendLog('Beende Vafrum Core...');

  printerReconnectTimers.forEach(timer => clearTimeout(timer));
  if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
  if (go2rtcWatchdogTimer) clearTimeout(go2rtcWatchdogTimer);
  if (rawMqttLogStream) { rawMqttLogStream.end(); rawMqttLogStream = null; }
  jpegStreams.forEach((s, serial) => stopJpegStream(serial));
  if (mjpegServer) mjpegServer.close();
  if (go2rtcProcess) go2rtcProcess.kill();
  if (tunnelProcess) tunnelProcess.kill();
  disconnectApi();

  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// === Start ===
sendLog('========================================');
sendLog('  Vafrum Core - Headless Bridge');
sendLog('  Version: 1.0.3');
sendLog('  Plattform: ' + process.platform + ' ' + process.arch);
sendLog('========================================');

loadConfig();
localIp = getLocalIp();
initLogging();

if (!config.apiKey) {
  sendLog('');
  sendLog('FEHLER: Kein API Key konfiguriert!');
  sendLog('Bitte config.json erstellen mit:');
  sendLog('  { "apiKey": "vfk_..." }');
  sendLog('');
  process.exit(1);
}

sendLog('API Key: ' + config.apiKey.substring(0, 8) + '...');
startMjpegServer();
startGo2rtc();
connectToApi(config.apiKey);

sendLog('Bridge läuft. Strg+C zum Beenden.');
