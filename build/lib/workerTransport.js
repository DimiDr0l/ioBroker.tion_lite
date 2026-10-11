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
var workerTransport_exports = {};
__export(workerTransport_exports, {
  WorkerTransport: () => WorkerTransport
});
module.exports = __toCommonJS(workerTransport_exports);
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"));
var import_transport = require("./transport");
var import_hciIpc = require("./hciIpc");
class WorkerTransport {
  /**
   * Create an isolated worker transport for one device session.
   *
   * @param address Configured BLE address.
   * @param hci Host HCI controller name.
   * @param spawn Fork implementation, replaceable in offline tests.
   * @param timeout Worker RPC deadline in milliseconds, including startup/discovery.
   */
  constructor(address, hci, spawn = import_node_child_process.fork, timeout = 65e3) {
    this.address = address;
    this.hci = hci;
    this.spawn = spawn;
    this.timeout = timeout;
  }
  onData = () => {
  };
  onDisconnect = () => {
  };
  onDriverState = () => {
  };
  child;
  closed = false;
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  handleMessage = (message) => {
    if (this.closed) {
      return;
    }
    if (!(0, import_hciIpc.isHciMessage)(message)) {
      this.fail(new Error("Invalid message from Bluetooth worker"));
      return;
    }
    switch (message.type) {
      case "data":
        this.onData(Buffer.from(message.hex, "hex"));
        break;
      case "driverState":
        this.onDriverState(message.state);
        break;
      case "fatal":
        this.fail(new Error(message.error));
        break;
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.identity);
        }
        break;
      }
    }
  };
  handleExit = (code, signal) => {
    var _a;
    this.fail(new Error(`Bluetooth worker exited (${(_a = signal != null ? signal : code) != null ? _a : "unknown"})`));
  };
  handleError = (error) => this.fail(error);
  fail(error) {
    if (this.closed) {
      return;
    }
    this.close(error);
    this.onDriverState("disconnected");
    this.onDisconnect(error);
  }
  request(message) {
    const child = this.child;
    if (this.closed || !(child == null ? void 0 : child.connected)) {
      return Promise.reject(new Error("Bluetooth worker is closed"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Bluetooth worker request timed out")), this.timeout);
      this.pending.set(message.id, { resolve, reject, timer });
      child.send(message, (error) => {
        if (error) {
          this.fail(new Error(`Bluetooth IPC failed: ${(0, import_transport.errorText)(error)}`));
        }
      });
    });
  }
  /** Fork a worker with the selected HCI, then wait for GATT readiness. */
  async connect() {
    var _a, _b;
    if (this.closed || this.child) {
      throw new Error("Bluetooth worker already started or closed");
    }
    if (!/^hci\d+$/.test(this.hci)) {
      throw new Error("Expected an HCI controller name such as hci0");
    }
    const env = { ...process.env, NOBLE_HCI_DEVICE_ID: this.hci.slice(3), NOBLE_BINDINGS: "hci" };
    delete env.HCI_CHANNEL_USER;
    this.child = this.spawn(import_node_path.default.join(__dirname, "..", "hciWorker.js"), [], {
      env,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child.on("message", this.handleMessage);
    this.child.on("exit", this.handleExit);
    this.child.on("error", this.handleError);
    this.child.on("disconnect", () => this.fail(new Error("Bluetooth worker IPC disconnected")));
    (_a = this.child.stdout) == null ? void 0 : _a.resume();
    (_b = this.child.stderr) == null ? void 0 : _b.resume();
    const identity = await this.request({
      type: "connect",
      id: ++this.nextId,
      address: this.address,
      hci: this.hci
    });
    if (!identity) {
      throw new Error("Bluetooth worker returned no device identity");
    }
    return identity;
  }
  /**
   * Send one ATT write through IPC and wait for its completion.
   *
   * @param frame Fragment including its BLE marker.
   * @param withResponse True for an ATT write request.
   */
  async write(frame, withResponse) {
    await this.request({ type: "write", id: ++this.nextId, hex: frame.toString("hex"), withResponse });
  }
  /**
   * Reject outstanding work and stop the native process, including a force-kill fallback.
   *
   * @param reason Error delivered to outstanding RPC requests.
   */
  close(reason = new Error("Bluetooth worker closed")) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    const child = this.child;
    this.child = void 0;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.removeListener("message", this.handleMessage);
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2e3);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WorkerTransport
});
//# sourceMappingURL=workerTransport.js.map
