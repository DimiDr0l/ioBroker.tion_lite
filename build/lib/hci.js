"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var hci_exports = {};
__export(hci_exports, {
  HciTransport: () => HciTransport
});
module.exports = __toCommonJS(hci_exports);
var import_protocol = require("./protocol");
const uuid = (value) => value.replace(/-/g, "").toLowerCase();
class HciTransport {
  /**
   * Configure one native HCI user-channel backend, separate from BlueZ.
   *
   * @param address Uppercase colon-separated breezer MAC address.
   * @param hci Dedicated controller name, such as hci1.
   * @param createNoble Backend factory, injectable in tests.
   * @param operationTimeout Deadline for scan/connect/discovery, in milliseconds.
   */
  constructor(address, hci, createNoble = async (deviceId) => {
    const { withBindings } = await Promise.resolve().then(() => __toESM(require("@stoprocent/noble")));
    return withBindings("hci", { hciDriver: "native", deviceId, userChannel: true });
  }, operationTimeout = 2e4) {
    this.address = address;
    this.hci = hci;
    this.createNoble = createNoble;
    this.operationTimeout = operationTimeout;
  }
  onData = () => {
  };
  onDisconnect = () => {
  };
  noble;
  peripheral;
  writer;
  notifier;
  abort = new AbortController();
  connected = false;
  scanning = false;
  handleError = (error) => {
    if (!this.abort.signal.aborted) {
      this.onDisconnect(error);
    }
  };
  handleState = (state) => {
    if (this.connected && state !== "poweredOn") {
      this.handleError(new Error(`Bluetooth controller became ${state}`));
    }
  };
  handleDisconnect = (reason) => {
    this.connected = false;
    this.handleError(new Error(`Bluetooth peripheral disconnected (${reason})`));
  };
  handleData = (data, isNotification) => {
    if (isNotification && !this.abort.signal.aborted) {
      this.onData(Buffer.from(data));
    }
  };
  async bounded(operation) {
    if (this.abort.signal.aborted) {
      throw new Error("Bluetooth transport is closed");
    }
    let timer;
    let cancel = () => {
    };
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`HCI operation timed out on ${this.hci}`)),
        this.operationTimeout
      );
      cancel = () => reject(new Error("Bluetooth transport is closed"));
      this.abort.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", cancel);
    }
  }
  async waitForController(noble) {
    if (noble.state === "poweredOn") {
      return;
    }
    const check = (state) => {
      if (["unsupported", "unauthorized"].includes(state)) {
        throw new Error(
          `${this.hci} is ${state}; check HCI access permissions and that the dedicated controller is down`
        );
      }
    };
    check(noble.state);
    let listener = (_state) => {
    };
    const ready = new Promise((resolve, reject) => {
      listener = (state) => {
        try {
          check(state);
          if (state === "poweredOn") {
            resolve();
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      noble.on("stateChange", listener);
    });
    try {
      await this.bounded(() => ready);
    } finally {
      noble.removeListener("stateChange", listener);
    }
  }
  async findPeripheral(noble) {
    let listener = (_peripheral) => {
    };
    const discovered = new Promise((resolve) => {
      listener = (peripheral) => {
        var _a;
        if (((_a = peripheral.address) == null ? void 0 : _a.toUpperCase()) === this.address) {
          resolve(peripheral);
        }
      };
      noble.on("discover", listener);
    });
    this.scanning = true;
    try {
      const [, peripheral] = await this.bounded(
        () => Promise.all([noble.startScanningAsync([], false), discovered])
      );
      return peripheral;
    } finally {
      noble.removeListener("discover", listener);
      if (!this.abort.signal.aborted) {
        await this.bounded(() => noble.stopScanningAsync());
      }
      this.scanning = false;
    }
  }
  /** Scan for the configured MAC, connect, resolve GATT and enable notifications. */
  async connect() {
    if (process.platform !== "linux") {
      throw new Error("Direct HCI transport requires Linux");
    }
    if (!/^hci\d+$/.test(this.hci)) {
      throw new Error("Expected an HCI controller name such as hci0");
    }
    const noble = await this.createNoble(Number(this.hci.slice(3)));
    this.noble = noble;
    if (this.abort.signal.aborted) {
      try {
        noble.stop();
      } catch {
      }
      throw new Error("Bluetooth transport is closed");
    }
    noble.on("error", this.handleError);
    await this.waitForController(noble);
    noble.on("stateChange", this.handleState);
    const peripheral = await this.findPeripheral(noble);
    this.peripheral = peripheral;
    peripheral.on("disconnect", this.handleDisconnect);
    await this.bounded(() => peripheral.connectAsync());
    const { characteristics } = await this.bounded(
      () => peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [uuid(import_protocol.UUIDS.service)],
        [uuid(import_protocol.UUIDS.write), uuid(import_protocol.UUIDS.notify)]
      )
    );
    this.writer = characteristics.find((item) => uuid(item.uuid) === uuid(import_protocol.UUIDS.write));
    this.notifier = characteristics.find((item) => uuid(item.uuid) === uuid(import_protocol.UUIDS.notify));
    if (!this.writer || !this.notifier) {
      throw new Error("Device does not expose BR_LITE write/notify characteristics");
    }
    if (!this.writer.properties.includes("write") || !this.writer.properties.includes("writeWithoutResponse")) {
      throw new Error("BR_LITE characteristic must support writes with and without response");
    }
    if (!this.notifier.properties.includes("notify") && !this.notifier.properties.includes("indicate")) {
      throw new Error("BR_LITE characteristic does not support notifications");
    }
    this.notifier.on("data", this.handleData);
    await this.bounded(() => this.notifier.subscribeAsync());
    this.connected = true;
    return { name: peripheral.advertisement.localName || "Br Lite", address: this.address };
  }
  /**
   * Write using the protocol's required ATT procedure.
   *
   * @param frame BLE value including the fragment marker.
   * @param withResponse True for a single-fragment command.
   */
  async write(frame, withResponse) {
    if (!this.writer || !this.connected || this.abort.signal.aborted) {
      throw new Error("Bluetooth not connected");
    }
    await this.bounded(() => this.writer.writeAsync(frame, !withResponse));
  }
  /** Release listeners, connections and the exclusive HCI socket. */
  close() {
    var _a, _b, _c, _d, _e;
    if (this.abort.signal.aborted) {
      return;
    }
    this.abort.abort();
    this.connected = false;
    (_a = this.notifier) == null ? void 0 : _a.removeListener("data", this.handleData);
    (_b = this.peripheral) == null ? void 0 : _b.removeListener("disconnect", this.handleDisconnect);
    (_c = this.noble) == null ? void 0 : _c.removeListener("stateChange", this.handleState);
    try {
      if (this.scanning) {
        (_d = this.noble) == null ? void 0 : _d.stopScanning();
      }
      (_e = this.noble) == null ? void 0 : _e.stop();
    } catch {
    }
    this.writer = void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HciTransport
});
//# sourceMappingURL=hci.js.map
