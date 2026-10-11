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
var hciWorker_exports = {};
__export(hciWorker_exports, {
  HciWorker: () => HciWorker
});
module.exports = __toCommonJS(hciWorker_exports);
var import_hci = require("./lib/hci");
var import_transport = require("./lib/transport");
class HciWorker {
  /**
   * Bind worker IPC to a lazily loaded native transport.
   *
   * @param send Structured parent notification callback.
   * @param create Construct the hardware backend only on connect.
   */
  constructor(send, create = (address, hci) => new import_hci.HciTransport(address, hci)) {
    this.send = send;
    this.create = create;
  }
  transport;
  queue = Promise.resolve();
  closed = false;
  /**
   * Handle one RPC; serialize hardware operations but allow immediate shutdown.
   *
   * @param value Parent request over IPC.
   */
  receive(value) {
    if (this.closed) {
      return;
    }
    if (!value || typeof value !== "object" || !("type" in value)) {
      this.send({ type: "fatal", error: "Invalid Bluetooth worker request" });
      this.close();
      return;
    }
    if (value.type === "close") {
      this.close();
      return;
    }
    if (!("id" in value) || !Number.isSafeInteger(value.id) || value.type !== "connect" && value.type !== "write") {
      this.send({ type: "fatal", error: "Invalid Bluetooth worker request" });
      this.close();
      return;
    }
    const request = value;
    this.queue = this.queue.then(async () => {
      if (this.closed) {
        return;
      }
      try {
        if (request.type === "connect") {
          if (typeof request.address !== "string" || !/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(request.address) || typeof request.hci !== "string" || !/^hci\d+$/.test(request.hci) || this.transport) {
            throw new Error("Invalid or duplicate Bluetooth connect request");
          }
          const transport = this.create(request.address, request.hci);
          this.transport = transport;
          transport.onData = (data) => this.send({ type: "data", hex: data.toString("hex") });
          transport.onDriverState = (state) => this.send({ type: "driverState", state });
          transport.onDisconnect = (error) => {
            this.send({ type: "fatal", error: (0, import_transport.errorText)(error) });
            this.close();
          };
          const identity = await transport.connect();
          if (!this.closed) {
            this.send({ type: "response", id: request.id, identity });
          }
        } else if (request.type === "write") {
          if (!this.transport || typeof request.hex !== "string" || request.hex.length > 40 || !/^(?:[\da-f]{2})+$/i.test(request.hex) || typeof request.withResponse !== "boolean") {
            throw new Error("Invalid Bluetooth write request");
          }
          await this.transport.write(Buffer.from(request.hex, "hex"), request.withResponse);
          if (!this.closed) {
            this.send({ type: "response", id: request.id });
          }
        }
      } catch (error) {
        if (!this.closed) {
          this.send({ type: "response", id: request.id, error: (0, import_transport.errorText)(error) });
        }
      }
    }).catch((error) => {
      this.send({ type: "fatal", error: (0, import_transport.errorText)(error) });
      this.close();
    });
  }
  /** Cancel hardware activity before the worker process exits. */
  close() {
    var _a;
    if (!this.closed) {
      this.closed = true;
      (_a = this.transport) == null ? void 0 : _a.close();
    }
  }
}
if (require.main === module) {
  const send = (message) => {
    if (process.connected && process.send) {
      process.send(message, (error) => {
        if (error) {
          process.exit(1);
        }
      });
    }
  };
  const worker = new HciWorker(send);
  const stop = () => {
    worker.close();
    process.exit(0);
  };
  const fatal = (error) => {
    send({ type: "fatal", error: (0, import_transport.errorText)(error) });
    worker.close();
    setTimeout(() => process.exit(1), 50);
  };
  process.on("message", (value) => worker.receive(value));
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HciWorker
});
//# sourceMappingURL=hciWorker.js.map
