"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_transport = require("./lib/transport");
var import_workerTransport = require("./lib/workerTransport");
var import_session = require("./lib/session");
var import_protocol = require("./lib/protocol");
class TionLite extends utils.Adapter {
  session;
  pollTimer;
  reconnectTimer;
  stopping = false;
  ready = false;
  lastState;
  reconnectDelay = 5e3;
  pendingControls = 0;
  constructor(options = {}) {
    super({ ...options, name: "tion_lite" });
    this.on("ready", () => {
      void this.onReady().catch((error) => this.log.error((0, import_transport.errorText)(error)));
    });
    this.on("stateChange", (id, state) => {
      void this.onStateChange(id, state).catch((error) => this.log.error((0, import_transport.errorText)(error)));
    });
    this.on("unload", (callback) => this.onUnload(callback));
  }
  async createStates() {
    for (const id of ["info", "control", "sensors", "diagnostics", "commands"]) {
      await this.setObjectNotExistsAsync(id, { type: "channel", common: { name: id }, native: {} });
    }
    const definitions = [
      [
        "info.driverState",
        { name: "Noble controller state", type: "string", role: "text", read: true, write: false }
      ],
      [
        "info.connection",
        { name: "Device ready", type: "boolean", role: "indicator.connected", read: true, write: false }
      ],
      ["info.address", { name: "Bluetooth address", type: "string", role: "text", read: true, write: false }],
      ["info.name", { name: "Device name", type: "string", role: "text", read: true, write: false }],
      ["info.model", { name: "Configured model", type: "string", role: "text", read: true, write: false }],
      [
        "info.firmwareVersion",
        { name: "Firmware version (raw)", type: "number", role: "value", read: true, write: false }
      ],
      [
        "info.firmwareHex",
        { name: "Firmware version (hex)", type: "string", role: "text", read: true, write: false }
      ],
      [
        "info.lastSeen",
        { name: "Last valid response", type: "number", role: "value.time", read: true, write: false }
      ],
      ["control.power", { name: "Power", type: "boolean", role: "switch.power", read: true, write: true }],
      [
        "control.heaterEnabled",
        { name: "Heater enabled", type: "boolean", role: "switch", read: true, write: true }
      ],
      [
        "control.targetTemperature",
        {
          name: "Heater target temperature",
          type: "number",
          role: "level.temperature",
          read: true,
          write: true,
          unit: "\xB0C",
          min: 0,
          max: this.config.maxTemperature,
          step: 1
        }
      ],
      [
        "control.fanSpeed",
        { name: "Fan speed", type: "number", role: "level", read: true, write: true, min: 1, max: 6, step: 1 }
      ],
      [
        "sensors.inputTemperature",
        {
          name: "Inlet temperature",
          type: "number",
          role: "value.temperature",
          read: true,
          write: false,
          unit: "\xB0C"
        }
      ],
      [
        "sensors.heaterPresent",
        { name: "Heater installed", type: "boolean", role: "indicator", read: true, write: false }
      ],
      [
        "diagnostics.errorMask",
        { name: "Device error/warning mask", type: "number", role: "value", read: true, write: false }
      ],
      [
        "diagnostics.lastError",
        { name: "Last communication/command error", type: "string", role: "text", read: true, write: false }
      ],
      [
        "diagnostics.commandStatus",
        { name: "Command status", type: "string", role: "text", read: true, write: false }
      ],
      [
        "commands.refresh",
        { name: "Read device state", type: "boolean", role: "button", read: false, write: true }
      ]
    ];
    for (const [id, common] of definitions) {
      await this.extendObjectAsync(id, { type: "state", common, native: {} });
    }
  }
  async onReady() {
    var _a, _b, _c;
    this.config.maxTemperature = Number((_a = this.config.maxTemperature) != null ? _a : 25);
    await this.createStates();
    await this.setStateAsync("info.connection", false, true);
    await this.setStateAsync("info.driverState", "unknown", true);
    await this.setStateAsync("diagnostics.commandStatus", "idle", true);
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test((_b = this.config.address) != null ? _b : "") || !/^hci\d+$/.test((_c = this.config.hci) != null ? _c : "") || !Number.isInteger(this.config.pollInterval) || this.config.pollInterval < 5 || this.config.pollInterval > 3600 || !Number.isInteger(this.config.responseTimeout) || this.config.responseTimeout < 1e3 || this.config.responseTimeout > 1e4 || ![25, 30].includes(this.config.maxTemperature)) {
      await this.reportError(
        "Configure a BLE MAC address, hci adapter, poll interval 5\u20133600 s, timeout 1000\u201310000 ms and temperature limit 25 or 30 \xB0C"
      );
      return;
    }
    this.config.address = this.config.address.toUpperCase();
    await this.setStateAsync("info.address", this.config.address, true);
    await this.setStateAsync("info.model", "BR_LITE", true);
    await this.subscribeStatesAsync("control.*");
    await this.subscribeStatesAsync("commands.refresh");
    await this.connectDevice();
  }
  async reportError(message) {
    this.log.warn(message);
    await this.setStateAsync("diagnostics.lastError", message, true);
  }
  publishState(state) {
    this.lastState = state;
    const values = {
      "control.power": state.power,
      "control.heaterEnabled": state.heaterEnabled,
      "control.targetTemperature": state.targetTemperature,
      "control.fanSpeed": state.fanSpeed,
      "sensors.inputTemperature": state.inputTemperature,
      "sensors.heaterPresent": state.heaterPresent,
      "diagnostics.errorMask": state.errorMask,
      "info.lastSeen": Date.now()
    };
    for (const [id, val] of Object.entries(values)) {
      void this.setStateAsync(id, val, true).catch((error) => this.log.error((0, import_transport.errorText)(error)));
    }
  }
  async connectDevice() {
    if (this.stopping || this.session) {
      return;
    }
    const transport = new import_workerTransport.WorkerTransport(this.config.address, this.config.hci);
    const session = new import_session.LiteSession(
      transport,
      {
        state: (state) => {
          if (this.session === session) {
            this.publishState(state);
          }
        },
        info: (info) => {
          if (this.session === session) {
            void Promise.all([
              this.setStateAsync("info.firmwareVersion", info.firmwareVersion, true),
              this.setStateAsync("info.firmwareHex", info.firmwareHex, true)
            ]).catch((error) => this.log.error((0, import_transport.errorText)(error)));
          }
        },
        invalid: (error) => this.log.debug(`Discarded BLE packet: ${(0, import_transport.errorText)(error)}`),
        disconnected: (error) => {
          void this.connectionFailed(session, error).catch((err) => this.log.error((0, import_transport.errorText)(err)));
        }
      },
      this.config.responseTimeout
    );
    transport.onDriverState = (state) => {
      if (this.session === session) {
        void this.setStateAsync("info.driverState", state, true).catch(
          (error) => this.log.error((0, import_transport.errorText)(error))
        );
      }
    };
    this.session = session;
    try {
      const identity = await session.initialize();
      if (this.session !== session || this.stopping) {
        return;
      }
      this.ready = true;
      this.reconnectDelay = 5e3;
      await this.setStateAsync("info.name", identity.name, true);
      await this.setStateAsync("info.connection", true, true);
      await this.setStateAsync("diagnostics.lastError", "", true);
      this.log.info(`Connected to ${identity.name} (${identity.address}) via ${this.config.hci}`);
      this.schedulePoll(session);
    } catch (error) {
      await this.connectionFailed(session, error);
    }
  }
  async connectionFailed(session, error) {
    if (this.session !== session) {
      return;
    }
    this.session = void 0;
    this.ready = false;
    this.lastState = void 0;
    clearTimeout(this.pollTimer);
    session.close();
    await this.setStateAsync("info.connection", false, true);
    await this.setStateAsync("diagnostics.commandStatus", "failed", true);
    await this.reportError((0, import_transport.errorText)(error));
    if (!this.stopping) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        void this.connectDevice().catch((err) => this.log.error((0, import_transport.errorText)(err)));
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 6e4);
    }
  }
  schedulePoll(session) {
    clearTimeout(this.pollTimer);
    if (this.stopping || this.session !== session) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      if (this.pendingControls) {
        this.schedulePoll(session);
        return;
      }
      void session.refresh().then(() => this.schedulePoll(session)).catch((error) => this.connectionFailed(session, error)).catch((error) => this.log.error((0, import_transport.errorText)(error)));
    }, this.config.pollInterval * 1e3);
  }
  async onStateChange(id, state) {
    if (!state || state.ack || this.stopping) {
      return;
    }
    const local = id.slice(this.namespace.length + 1);
    const refresh = local === "commands.refresh";
    const key = local.startsWith("control.") ? local.slice(8) : void 0;
    if (!refresh && (!key || !["power", "heaterEnabled", "targetTemperature", "fanSpeed"].includes(key))) {
      return;
    }
    if (refresh && state.val !== true) {
      return;
    }
    const session = this.session;
    let executing = false;
    try {
      if (!session || !this.ready) {
        throw new Error("Device is not ready; wait for info.connection=true");
      }
      if (refresh) {
        await session.refresh();
      } else if (key) {
        const patch = { [key]: state.val };
        (0, import_protocol.validateControls)(patch);
        if (key === "targetTemperature" && state.val > this.config.maxTemperature) {
          throw new Error(`Configured temperature limit is ${this.config.maxTemperature} \xB0C`);
        }
        if (this.pendingControls >= 10) {
          throw new Error("Too many pending control commands");
        }
        this.pendingControls++;
        executing = true;
        await this.setStateAsync("diagnostics.commandStatus", "pending", true);
        await session.update(patch);
        if (this.session === session) {
          await this.setStateAsync("diagnostics.lastError", "", true);
          await this.setStateAsync(
            "diagnostics.commandStatus",
            this.pendingControls > 1 ? "pending" : "confirmed",
            true
          );
        }
      }
    } catch (error) {
      if (session && this.session !== session) {
        return;
      }
      await this.reportError((0, import_transport.errorText)(error));
      if (key && this.lastState) {
        await this.setStateAsync(local, { val: this.lastState[key], ack: true, q: 68 });
      }
      await this.setStateAsync("diagnostics.commandStatus", "failed", true);
      if (session && (executing || refresh)) {
        await this.connectionFailed(session, error);
      }
    } finally {
      if (executing) {
        this.pendingControls--;
      }
      if (refresh) {
        await this.setStateAsync("commands.refresh", false, true);
      }
    }
  }
  onUnload(callback) {
    var _a;
    this.stopping = true;
    this.ready = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.reconnectTimer);
    let called = false;
    const finish = () => {
      if (!called) {
        called = true;
        callback();
      }
    };
    const timer = setTimeout(finish, 1e3);
    try {
      (_a = this.session) == null ? void 0 : _a.close();
      this.session = void 0;
      void this.setStateAsync("info.connection", false, true).catch(() => {
      }).finally(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new TionLite(options);
} else {
  new TionLite();
}
//# sourceMappingURL=main.js.map
