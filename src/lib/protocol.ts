import { randomBytes } from "node:crypto";

export const UUIDS = {
    service: "98f00001-3788-83ea-453e-f52244709ddb",
    write: "98f00002-3788-83ea-453e-f52244709ddb",
    notify: "98f00003-3788-83ea-453e-f52244709ddb",
};

export const OPCODE = { set: 0x1230, get: 0x1232, state: 0x1231, info: 0x4009, infoResponse: 0x400a };

/** Decoded state, including settings outside the writable ioBroker controls. */
export interface LiteState {
    /** Breezer power flag. */
    power: boolean;
    /** Configured permission to heat; not actual heater activity. */
    heaterEnabled: boolean;
    /** Device reports an installed heater. */
    heaterPresent: boolean;
    /** Requested heater setpoint in degrees Celsius. */
    targetTemperature: number;
    /** Fan setting; zero may be reported while stopped. */
    fanSpeed: number;
    /** Signed inlet air temperature in degrees Celsius. */
    inputTemperature: number;
    /** Preserved sound indication setting. */
    sound: boolean;
    /** Preserved light indication setting. */
    light: boolean;
    /** All three device temperature presets, preserved on writes. */
    temperaturePresets: number[];
    /** All three device fan presets, preserved on writes. */
    fanPresets: number[];
    /** Signed raw remaining filter lifetime. */
    filterRemainingSeconds: number;
    /** Unsigned error and warning bitmask. */
    errorMask: number;
}

export type Controls = Pick<LiteState, "power" | "heaterEnabled" | "targetTemperature" | "fanSpeed">;
/** Firmware fields actually decoded by the Android LITE parser. */
export interface DeviceInfo {
    /** Raw little-endian 16-bit firmware version. */
    firmwareVersion: number;
    /** Four-character firmware version in hexadecimal. */
    firmwareHex: string;
}

/**
 * Compute non-reflected CCITT CRC with initial value 0xFFFF.
 *
 * @param data Logical message bytes excluding the CRC.
 */
export function crc16(data: Buffer): number {
    let crc = 0xffff;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
        }
    }
    return crc;
}

/**
 * Encode IDs in wire order, not the reversed order of the Android random arrays.
 *
 * @param opcode Numeric command opcode.
 * @param payload Command-specific payload bytes.
 * @param random Nine entropy bytes; injectable for reproducible wire tests.
 */
export function encodeCommand(
    opcode: number,
    payload: Buffer = Buffer.alloc(0),
    random: Buffer = randomBytes(9),
): Buffer {
    if (random.length !== 9) {
        throw new Error("Expected 9 random bytes");
    }
    const hasCommandId = opcode !== OPCODE.info;
    const offset = hasCommandId ? 14 : 10;
    const message = Buffer.alloc(offset + payload.length + 2);
    message.writeUInt16LE(message.length, 0);
    message[2] = 0x3a;
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

/**
 * Split a message into BLE values of at most 20 bytes.
 *
 * @param message Complete logical message with CRC.
 */
export function fragment(message: Buffer): Buffer[] {
    if (message.length <= 19) {
        return [Buffer.concat([Buffer.from([0x80]), message])];
    }
    const result: Buffer[] = [];
    for (let i = 0; i < message.length; i += 19) {
        const marker = i === 0 ? 0 : i + 19 >= message.length ? 0xc0 : 0x40;
        result.push(Buffer.concat([Buffer.from([marker]), message.subarray(i, i + 19)]));
    }
    return result;
}

/**
 * Build the Android 14-byte SET payload, preserving presets and indication.
 *
 * @param state Fresh confirmed configuration with desired control changes.
 */
export function encodeSettings(state: LiteState): Buffer {
    validateControls(state);
    if (state.temperaturePresets.length !== 3 || state.fanPresets.length !== 3) {
        throw new Error("Missing device presets; read state before writing");
    }
    const payload = Buffer.alloc(14);
    payload[0] = Number(state.power) | (state.sound ? 2 : 0) | (state.light ? 4 : 0) | (state.heaterEnabled ? 0x10 : 0);
    payload[2] = 2;
    payload.writeInt8(state.targetTemperature, 3);
    payload[4] = state.fanSpeed;
    state.temperaturePresets.forEach((value, index) => payload.writeInt8(value, 5 + index));
    state.fanPresets.forEach((value, index) => {
        payload[8 + index] = value;
    });
    // No skipSettings, resetFilter or ROM save in the supported control operations.
    return payload;
}

/**
 * Reject non-integer or out-of-range writable control values.
 *
 * @param patch Subset of supported control values, or the full cached state.
 */
export function validateControls(patch: Partial<Controls>): void {
    for (const key of Object.keys(patch)) {
        if (!["power", "heaterEnabled", "targetTemperature", "fanSpeed"].includes(key)) {
            // Full LiteState is also accepted by encodeSettings; ignored metadata is not writable.
            continue;
        }
        const value = patch[key as keyof Controls];
        if (key === "power" || key === "heaterEnabled") {
            if (typeof value !== "boolean") {
                throw new Error(`${key} must be boolean`);
            }
        } else if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < (key === "fanSpeed" ? 1 : 0) ||
            value > (key === "fanSpeed" ? 6 : 30)
        ) {
            throw new Error(`${key} must be an integer in ${key === "fanSpeed" ? "1–6" : "0–30"}`);
        }
    }
}

/**
 * Check message bounds, magic and CRC before dispatching its opcode.
 *
 * @param message Assembled logical message without BLE markers.
 */
export function validateMessage(message: Buffer): number {
    if (message.length < 12 || message.length > 4096 || message.readUInt16LE(0) !== message.length) {
        throw new Error("Invalid BR_LITE message length");
    }
    if (message[2] !== 0x3a) {
        throw new Error("Invalid BR_LITE magic");
    }
    if (message.readUInt16BE(message.length - 2) !== crc16(message.subarray(0, -2))) {
        throw new Error("Invalid BR_LITE CRC");
    }
    return message.readUInt16LE(4);
}

/**
 * Decode state fields at offsets used by the Android LITE parser.
 *
 * @param message Complete validated logical state response.
 */
export function decodeState(message: Buffer): LiteState {
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
        heaterEnabled: !!(data[0] & 0x40),
        /** Device reports an installed heater. */
        heaterPresent: !!(data[0] & 0x80),
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
        temperaturePresets: [48, 49, 50].map(offset => data.readInt8(offset)),
        /** All three device fan presets, preserved on writes. */
        fanPresets: [data[51], data[52], data[53]],
    };
}

/**
 * Decode firmware at logical offsets 15 and 16.
 *
 * @param message Complete validated device-info response.
 */
export function decodeInfo(message: Buffer): DeviceInfo {
    if (validateMessage(message) !== OPCODE.infoResponse || message.length < 19) {
        throw new Error("Incomplete BR_LITE device info response");
    }
    const firmwareVersion = message.readUInt16LE(15);
    return { firmwareVersion, firmwareHex: firmwareVersion.toString(16).padStart(4, "0").toUpperCase() };
}

/** Assembles logical messages without retaining any fragment markers. */
export class FrameAssembler {
    private pending?: Buffer;
    private started = 0;

    /** Forget incomplete data after disconnect or a new packet. */
    public reset(): void {
        this.pending = undefined;
        this.started = 0;
    }

    /**
     * Accept a notification and return a complete validated logical message.
     *
     * @param frame BLE value including its marker.
     * @param now Current milliseconds, injectable for assembly timeout tests.
     */
    public push(frame: Buffer, now = Date.now()): Buffer | undefined {
        if (this.pending && now - this.started > 2000) {
            this.reset();
        }
        if (frame.length < 2) {
            this.reset();
            throw new Error("Empty BLE fragment");
        }
        const marker = frame[0];
        if (marker === 0x80) {
            this.reset();
            const message = Buffer.from(frame.subarray(1));
            validateMessage(message);
            return message;
        }
        if (marker === 0) {
            this.pending = Buffer.from(frame.subarray(1));
            this.started = now;
        } else if ((marker === 0x40 || marker === 0xc0) && this.pending) {
            this.pending = Buffer.concat([this.pending, frame.subarray(1)]);
        } else {
            this.reset();
            throw new Error("Unexpected BLE fragment sequence");
        }
        if (
            this.pending.length > 4096 ||
            (this.pending.length >= 2 && this.pending.length > this.pending.readUInt16LE(0))
        ) {
            this.reset();
            throw new Error("BLE assembly exceeds declared length");
        }
        if (marker === 0xc0) {
            const message = this.pending;
            this.reset();
            validateMessage(message);
            return message;
        }
        return undefined;
    }
}
