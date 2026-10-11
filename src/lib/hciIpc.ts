/** Requests crossing the child-process boundary; bytes are hex to avoid Buffer revivers. */
export type HciRequest =
    | { type: "connect"; id: number; address: string; hci: string }
    | { type: "write"; id: number; hex: string; withResponse: boolean }
    | { type: "close" };

/** Worker events and RPC responses. Native Error objects never cross IPC directly. */
export type HciMessage =
    | { type: "response"; id: number; identity?: { name: string; address: string }; error?: string }
    | { type: "data"; hex: string }
    | { type: "driverState"; state: string }
    | { type: "fatal"; error: string };

/**
 * Validate a child-process message before using it in the parent.
 *
 * @param value Message received over IPC.
 */
export function isHciMessage(value: unknown): value is HciMessage {
    if (!value || typeof value !== "object" || !("type" in value)) {
        return false;
    }
    switch (value.type) {
        case "data":
            return (
                "hex" in value &&
                typeof value.hex === "string" &&
                value.hex.length <= 8192 &&
                /^(?:[a-f\d]{2})+$/i.test(value.hex)
            );
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
                if (
                    !identity ||
                    typeof identity !== "object" ||
                    !("name" in identity) ||
                    !("address" in identity) ||
                    typeof identity.name !== "string" ||
                    typeof identity.address !== "string"
                ) {
                    return false;
                }
            }
            return true;
        default:
            return false;
    }
}
