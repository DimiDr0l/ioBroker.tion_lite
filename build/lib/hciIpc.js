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
var hciIpc_exports = {};
__export(hciIpc_exports, {
  isHciMessage: () => isHciMessage
});
module.exports = __toCommonJS(hciIpc_exports);
function isHciMessage(value) {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  switch (value.type) {
    case "data":
      return "hex" in value && typeof value.hex === "string" && value.hex.length <= 8192 && /^(?:[a-f\d]{2})+$/i.test(value.hex);
    case "driverState":
      return "state" in value && typeof value.state === "string";
    case "fatal":
      return "error" in value && typeof value.error === "string";
    case "response":
      if (!("id" in value) || !Number.isSafeInteger(value.id)) {
        return false;
      }
      if ("error" in value && typeof value.error !== "string") {
        return false;
      }
      if ("identity" in value) {
        const identity = value.identity;
        if (!identity || typeof identity !== "object" || !("name" in identity) || !("address" in identity) || typeof identity.name !== "string" || typeof identity.address !== "string") {
          return false;
        }
      }
      return true;
    default:
      return false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isHciMessage
});
//# sourceMappingURL=hciIpc.js.map
