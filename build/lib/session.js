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
var session_exports = {};
__export(session_exports, {
  LiteSession: () => LiteSession
});
module.exports = __toCommonJS(session_exports);
var import_promises = require("node:timers/promises");
var import_protocol = require("./protocol");
class LiteSession {
  /**
   * Bind protocol processing to a transport.
   *
   * @param transport BLE backend.
   * @param callbacks Connection-scoped observer callbacks.
   * @param responseTimeout Device response deadline in milliseconds.
   * @param readbackDelay Delay after SET before the verification GET.
   */
  constructor(transport, callbacks, responseTimeout = 3e3, readbackDelay = 1500) {
    this.transport = transport;
    this.callbacks = callbacks;
    this.responseTimeout = responseTimeout;
    this.readbackDelay = readbackDelay;
    transport.onData = (data) => this.receive(data);
    transport.onDisconnect = (error) => {
      this.close();
      callbacks.disconnected(error);
    };
  }
  assembler = new import_protocol.FrameAssembler();
  abort = new AbortController();
  queue = Promise.resolve();
  waiter;
  latest;
  receive(data) {
    var _a;
    if (this.abort.signal.aborted) {
      return;
    }
    try {
      const message = this.assembler.push(data);
      if (!message) {
        return;
      }
      const opcode = message.readUInt16LE(4);
      if (opcode === import_protocol.OPCODE.state) {
        this.latest = (0, import_protocol.decodeState)(message);
        this.callbacks.state(this.latest);
      } else if (opcode === import_protocol.OPCODE.infoResponse) {
        this.callbacks.info((0, import_protocol.decodeInfo)(message));
      }
      if (((_a = this.waiter) == null ? void 0 : _a.opcode) === opcode) {
        this.waiter.resolve(message);
      }
    } catch (error) {
      this.callbacks.invalid(error instanceof Error ? error : new Error(String(error)));
    }
  }
  enqueue(job) {
    const operation = this.queue.then(() => {
      if (this.abort.signal.aborted) {
        throw new Error("Device session is closed");
      }
      return job();
    });
    this.queue = operation.catch(() => {
    });
    return operation;
  }
  async send(opcode, payload) {
    const frames = (0, import_protocol.fragment)((0, import_protocol.encodeCommand)(opcode, payload));
    for (const frame of frames) {
      if (this.abort.signal.aborted) {
        throw new Error("Device session is closed");
      }
      await this.transport.write(frame, frames.length === 1);
      if (frames.length > 1) {
        await (0, import_promises.setTimeout)(3, void 0, { signal: this.abort.signal });
      }
    }
  }
  async request(opcode, response) {
    let timer;
    const result = new Promise((resolve, reject) => {
      this.waiter = { opcode: response, resolve, reject };
      timer = setTimeout(
        () => reject(new Error(`Response timeout for 0x${opcode.toString(16)}`)),
        this.responseTimeout
      );
    });
    const sending = this.send(opcode);
    try {
      const [message] = await Promise.all([result, sending]);
      return message;
    } finally {
      clearTimeout(timer);
      this.waiter = void 0;
    }
  }
  /** Establish notifications and obtain firmware plus the first configuration. */
  initialize() {
    return this.enqueue(async () => {
      const identity = await this.transport.connect();
      await this.request(import_protocol.OPCODE.info, import_protocol.OPCODE.infoResponse);
      await this.request(import_protocol.OPCODE.get, import_protocol.OPCODE.state);
      return identity;
    });
  }
  /** Queue one state query behind all current operations. */
  refresh() {
    return this.enqueue(async () => {
      await this.request(import_protocol.OPCODE.get, import_protocol.OPCODE.state);
    });
  }
  /**
   * Preserve a fresh configuration, apply changes and verify actual readback.
   *
   * @param patch Writable fields requested by the user.
   */
  update(patch) {
    return this.enqueue(async () => {
      (0, import_protocol.validateControls)(patch);
      await this.request(import_protocol.OPCODE.get, import_protocol.OPCODE.state);
      if (!this.latest) {
        throw new Error("No confirmed device configuration");
      }
      const next = { ...this.latest, fanSpeed: this.latest.fanSpeed === 0 ? 1 : this.latest.fanSpeed, ...patch };
      if (next.heaterEnabled && !next.heaterPresent) {
        throw new Error("Device reports no heater");
      }
      await this.send(import_protocol.OPCODE.set, (0, import_protocol.encodeSettings)(next));
      await (0, import_promises.setTimeout)(this.readbackDelay, void 0, { signal: this.abort.signal });
      const readback = (0, import_protocol.decodeState)(await this.request(import_protocol.OPCODE.get, import_protocol.OPCODE.state));
      for (const key of Object.keys(patch)) {
        if (readback[key] !== next[key]) {
          throw new Error(`Device did not confirm ${key}: requested ${next[key]}, received ${readback[key]}`);
        }
      }
    });
  }
  /** Abort outstanding operations and prevent queued commands from replaying. */
  close() {
    var _a;
    if (this.abort.signal.aborted) {
      return;
    }
    this.abort.abort();
    (_a = this.waiter) == null ? void 0 : _a.reject(new Error("Device session closed"));
    this.assembler.reset();
    this.latest = void 0;
    this.transport.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LiteSession
});
//# sourceMappingURL=session.js.map
