"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var protocol_exports = {};
__export(protocol_exports, {
  FrameAssembler: () => FrameAssembler,
  OPCODE: () => OPCODE,
  UUIDS: () => UUIDS,
  crc16: () => crc16,
  decodeInfo: () => decodeInfo,
  decodeState: () => decodeState,
  encodeCommand: () => encodeCommand,
  encodeSettings: () => encodeSettings,
  fragment: () => fragment,
  validateControls: () => validateControls,
  validateMessage: () => validateMessage
});
module.exports = __toCommonJS(protocol_exports);
var import_node_crypto = require("node:crypto");
const UUIDS = {
  service: "98f00001-3788-83ea-453e-f52244709ddb",
  write: "98f00002-3788-83ea-453e-f52244709ddb",
  notify: "98f00003-3788-83ea-453e-f52244709ddb"
};
const OPCODE = { set: 4656, get: 4658, state: 4657, info: 16393, infoResponse: 16394 };
function crc16(data) {
  let crc = 65535;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc << 1 ^ (crc & 32768 ? 4129 : 0)) & 65535;
    }
  }
  return crc;
}
function encodeCommand(opcode, payload = Buffer.alloc(0), random = (0, import_node_crypto.randomBytes)(9)) {
  if (random.length !== 9) {
    throw new Error("Expected 9 random bytes");
  }
  const hasCommandId = opcode !== OPCODE.info;
  const offset = hasCommandId ? 14 : 10;
  const message = Buffer.alloc(offset + payload.length + 2);
  message.writeUInt16LE(message.length, 0);
  message[2] = 58;
  message[3] = random[0];
  message.writeUInt16LE(opcode, 4);
  random.copy(message, 6, 1, 5);
  if (hasCommandId) {
    random.copy(message, 10, 5, 9);
  }
  payload.copy(message, offset);
  message.writeUInt16BE(crc16(message.subarray(0, -2)), message.length - 2);
  return message;
}
function fragment(message) {
  if (message.length <= 19) {
    return [Buffer.concat([Buffer.from([128]), message])];
  }
  const result = [];
  for (let i = 0; i < message.length; i += 19) {
    const marker = i === 0 ? 0 : i + 19 >= message.length ? 192 : 64;
    result.push(Buffer.concat([Buffer.from([marker]), message.subarray(i, i + 19)]));
  }
  return result;
}
function encodeSettings(state) {
  validateControls(state);
  if (state.temperaturePresets.length !== 3 || state.fanPresets.length !== 3) {
    throw new Error("Missing device presets; read state before writing");
  }
  const payload = Buffer.alloc(14);
  payload[0] = Number(state.power) | (state.sound ? 2 : 0) | (state.light ? 4 : 0) | (state.heaterEnabled ? 16 : 0);
  payload[2] = 2;
  payload.writeInt8(state.targetTemperature, 3);
  payload[4] = state.fanSpeed;
  state.temperaturePresets.forEach((value, index) => payload.writeInt8(value, 5 + index));
  state.fanPresets.forEach((value, index) => {
    payload[8 + index] = value;
  });
  return payload;
}
function validateControls(patch) {
  for (const key of Object.keys(patch)) {
    if (!["power", "heaterEnabled", "targetTemperature", "fanSpeed"].includes(key)) {
      continue;
    }
    const value = patch[key];
    if (key === "power" || key === "heaterEnabled") {
      if (typeof value !== "boolean") {
        throw new Error(`${key} must be boolean`);
      }
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < (key === "fanSpeed" ? 1 : 0) || value > (key === "fanSpeed" ? 6 : 30)) {
      throw new Error(`${key} must be an integer in ${key === "fanSpeed" ? "1\u20136" : "0\u201330"}`);
    }
  }
}
function validateMessage(message) {
  if (message.length < 12 || message.length > 4096 || message.readUInt16LE(0) !== message.length) {
    throw new Error("Invalid BR_LITE message length");
  }
  if (message[2] !== 58) {
    throw new Error("Invalid BR_LITE magic");
  }
  if (message.readUInt16BE(message.length - 2) !== crc16(message.subarray(0, -2))) {
    throw new Error("Invalid BR_LITE CRC");
  }
  return message.readUInt16LE(4);
}
function decodeState(message) {
  if (validateMessage(message) !== OPCODE.state || message.length < 70) {
    throw new Error("Incomplete BR_LITE state response");
  }
  const data = message.subarray(14, -2);
  return {
    /** Breezer power flag. */
    power: !!(data[0] & 1),
    /** Preserved sound indication setting. */
    sound: !!(data[0] & 2),
    /** Preserved light indication setting. */
    light: !!(data[0] & 4),
    /** Configured permission to heat; not actual heater activity. */
    heaterEnabled: !!(data[0] & 64),
    /** Device reports an installed heater. */
    heaterPresent: !!(data[0] & 128),
    /** Requested heater setpoint in degrees Celsius. */
    targetTemperature: data.readInt8(3),
    /** Fan setting; zero may be reported while stopped. */
    fanSpeed: data[4],
    /** Signed inlet air temperature in degrees Celsius. */
    inputTemperature: data.readInt8(5),
    /** Signed raw remaining filter lifetime. */
    filterRemainingSeconds: data.readInt32LE(16),
    /** Unsigned error and warning bitmask. */
    errorMask: data.readUInt32LE(24),
    /** All three device temperature presets, preserved on writes. */
    temperaturePresets: [48, 49, 50].map((offset) => data.readInt8(offset)),
    /** All three device fan presets, preserved on writes. */
    fanPresets: [data[51], data[52], data[53]]
  };
}
function decodeInfo(message) {
  if (validateMessage(message) !== OPCODE.infoResponse || message.length < 19) {
    throw new Error("Incomplete BR_LITE device info response");
  }
  const firmwareVersion = message.readUInt16LE(15);
  return { firmwareVersion, firmwareHex: firmwareVersion.toString(16).padStart(4, "0").toUpperCase() };
}
class FrameAssembler {
  pending;
  started = 0;
  /** Forget incomplete data after disconnect or a new packet. */
  reset() {
    this.pending = void 0;
    this.started = 0;
  }
  /**
   * Accept a notification and return a complete validated logical message.
   *
   * @param frame BLE value including its marker.
   * @param now Current milliseconds, injectable for assembly timeout tests.
   */
  push(frame, now = Date.now()) {
    if (this.pending && now - this.started > 2e3) {
      this.reset();
    }
    if (frame.length < 2) {
      this.reset();
      throw new Error("Empty BLE fragment");
    }
    const marker = frame[0];
    if (marker === 128) {
      this.reset();
      const message = Buffer.from(frame.subarray(1));
      validateMessage(message);
      return message;
    }
    if (marker === 0) {
      this.pending = Buffer.from(frame.subarray(1));
      this.started = now;
    } else if ((marker === 64 || marker === 192) && this.pending) {
      this.pending = Buffer.concat([this.pending, frame.subarray(1)]);
    } else {
      this.reset();
      throw new Error("Unexpected BLE fragment sequence");
    }
    if (this.pending.length > 4096 || this.pending.length >= 2 && this.pending.length > this.pending.readUInt16LE(0)) {
      this.reset();
      throw new Error("BLE assembly exceeds declared length");
    }
    if (marker === 192) {
      const message = this.pending;
      this.reset();
      validateMessage(message);
      return message;
    }
    return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FrameAssembler,
  OPCODE,
  UUIDS,
  crc16,
  decodeInfo,
  decodeState,
  encodeCommand,
  encodeSettings,
  fragment,
  validateControls,
  validateMessage
});
//# sourceMappingURL=protocol.js.map
