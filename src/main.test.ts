/* eslint-disable @typescript-eslint/require-await -- Fake async transports implement the production Promise API. */
import { describe, it } from "mocha";
import { expect } from "chai";
import {
    crc16,
    decodeInfo,
    decodeState,
    encodeCommand,
    encodeSettings,
    fragment,
    FrameAssembler,
    OPCODE,
    type LiteState,
} from "./lib/protocol";
import { LiteSession } from "./lib/session";
import type { Transport } from "./lib/transport";

const random = Buffer.from("5a0102030405060708", "hex");
const initial: LiteState = {
    power: true,
    heaterEnabled: true,
    heaterPresent: true,
    targetTemperature: 22,
    fanSpeed: 3,
    inputTemperature: -5,
    sound: true,
    light: true,
    temperaturePresets: [18, 22, 25],
    fanPresets: [1, 3, 6],
    filterRemainingSeconds: 15552000,
    errorMask: 0x09000401,
};

function stateMessage(state = initial): Buffer {
    const payload = Buffer.alloc(54);
    payload[0] =
        Number(state.power) |
        (state.sound ? 2 : 0) |
        (state.light ? 4 : 0) |
        (state.heaterEnabled ? 0x40 : 0) |
        (state.heaterPresent ? 0x80 : 0);
    payload.writeInt8(state.targetTemperature, 3);
    payload[4] = state.fanSpeed;
    payload.writeInt8(state.inputTemperature, 5);
    payload.writeInt32LE(state.filterRemainingSeconds, 16);
    payload.writeUInt32LE(state.errorMask, 24);
    state.temperaturePresets.forEach((value, i) => payload.writeInt8(value, 48 + i));
    state.fanPresets.forEach((value, i) => {
        payload[51 + i] = value;
    });
    return encodeCommand(OPCODE.state, payload, random);
}

function infoMessage(): Buffer {
    // Android reads R[16:18], i.e. logical message[15:17].
    const message = encodeCommand(OPCODE.infoResponse, Buffer.from([0, 0x34, 0x12]), random);
    return message;
}

describe("BR_LITE wire codec", () => {
    it("matches independently generated GET_STATE and GET_INFO vectors", () => {
        expect(crc16(Buffer.from("123456789"))).to.equal(0x29b1);
        expect(encodeCommand(OPCODE.get, undefined, random).toString("hex")).to.equal(
            "10003a5a32120102030405060708a8de",
        );
        expect(encodeCommand(OPCODE.info, undefined, random).toString("hex")).to.equal("0c003a5a0940010203049cb7");
    });
    it("matches the SET_STATE vector, preserving presets and indication flags", () => {
        const message = encodeCommand(OPCODE.set, encodeSettings(initial), random);
        expect(message.toString("hex")).to.equal("1e003a5a301201020304050607081700021603121619010306000000c077");
        expect(fragment(message).map(frame => frame.toString("hex"))).to.deep.equal([
            "001e003a5a301201020304050607081700021603",
            "c0121619010306000000c077",
        ]);
        const off = encodeSettings({ ...initial, power: false });
        expect(off[0] & 1).to.equal(0);
        expect(off[4]).to.equal(3);
        expect(off.subarray(11).toString("hex")).to.equal("000000");
    });
    it("decodes signed temperatures, heater bits, counters and firmware at Android offsets", () => {
        expect(decodeState(stateMessage())).to.deep.equal(initial);
        expect(decodeInfo(infoMessage())).to.deep.equal({ firmwareVersion: 4660, firmwareHex: "1234" });
        expect(encodeSettings(initial)[0] & 0x10).to.equal(0x10);
        expect(encodeSettings(initial)[0] & 0x40).to.equal(0);
    });
    it("assembles multiple notifications, resets stale frames and rejects corruption", () => {
        const assembler = new FrameAssembler();
        const message = stateMessage();
        const frames = fragment(message);
        let result: Buffer | undefined;
        frames.forEach(frame => {
            result = assembler.push(frame);
        });
        expect(result).to.deep.equal(message);
        expect(() => assembler.push(frames[frames.length - 1])).to.throw("sequence");
        assembler.push(frames[0], 100);
        expect(() => assembler.push(frames[1], 2201)).to.throw("sequence");
        assembler.push(frames[0]);
        const single = fragment(encodeCommand(OPCODE.get, undefined, random))[0];
        expect(assembler.push(single)).to.deep.equal(single.subarray(1));
        single[single.length - 1] ^= 1;
        expect(() => assembler.push(single)).to.throw("CRC");
        const length = Buffer.from(single);
        length[1] = 0;
        expect(() => assembler.push(length)).to.throw("length");
        expect(() => decodeState(encodeCommand(OPCODE.state, Buffer.alloc(20)))).to.throw("Incomplete");
    });
    it("rejects invalid controls instead of wrapping bytes", () => {
        for (const patch of [
            { fanSpeed: 0 },
            { fanSpeed: 7 },
            { fanSpeed: 1.5 },
            { targetTemperature: 31 },
            { targetTemperature: -1 },
            { targetTemperature: NaN },
        ]) {
            expect(() => encodeSettings({ ...initial, ...patch })).to.throw();
        }
    });
});

class FakeTransport implements Transport {
    public onData: (data: Buffer) => void = () => {};
    public onDisconnect: (reason: Error) => void = () => {};
    public state = { ...initial };
    public ignoreSet = false;
    public silent = false;
    public failWrite = false;
    public closed = false;
    public opcodes: number[] = [];
    public types: boolean[] = [];
    public settings: Buffer[] = [];
    private assembler = new FrameAssembler();

    public async connect(): Promise<{ name: string; address: string }> {
        return { name: "Br Lite", address: "00:11:22:33:44:55" };
    }
    public async write(frame: Buffer, withResponse: boolean): Promise<void> {
        if (this.closed || this.failWrite) {
            throw new Error("write failed");
        }
        this.types.push(withResponse);
        const message = this.assembler.push(frame);
        if (!message) {
            return;
        }
        const opcode = message.readUInt16LE(4);
        this.opcodes.push(opcode);
        if (this.silent) {
            return;
        }
        if (opcode === OPCODE.info) {
            this.reply(infoMessage());
        } else if (opcode === OPCODE.get) {
            this.reply(stateMessage(this.state));
        } else if (opcode === OPCODE.set) {
            const payload = message.subarray(14, -2);
            this.settings.push(Buffer.from(payload));
            if (!this.ignoreSet) {
                this.state = {
                    ...this.state,
                    power: !!(payload[0] & 1),
                    heaterEnabled: !!(payload[0] & 0x10),
                    targetTemperature: payload[3],
                    fanSpeed: payload[4],
                };
            }
        }
    }
    public reply(message: Buffer): void {
        fragment(message).forEach(frame => this.onData(frame));
    }
    public close(): void {
        this.closed = true;
    }
}

function makeSession(transport: FakeTransport): LiteSession {
    return new LiteSession(
        transport,
        {
            state: () => {},
            info: () => {},
            invalid: () => {},
            disconnected: () => {},
        },
        40,
        1,
    );
}

async function rejects(operation: Promise<unknown>, match: string): Promise<void> {
    let failure: unknown;
    try {
        await operation;
    } catch (error) {
        failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.contain(match);
}

describe("BR_LITE device session", () => {
    it("initializes and serializes queued changes with fresh configuration and readback", async () => {
        const transport = new FakeTransport();
        const session = makeSession(transport);
        try {
            await session.initialize();
            await Promise.all([
                session.update({ power: false }),
                session.update({ fanSpeed: 6 }),
                session.update({ heaterEnabled: false }),
                session.update({ targetTemperature: 25 }),
            ]);
            expect(transport.opcodes).to.deep.equal([
                OPCODE.info,
                OPCODE.get,
                OPCODE.get,
                OPCODE.set,
                OPCODE.get,
                OPCODE.get,
                OPCODE.set,
                OPCODE.get,
                OPCODE.get,
                OPCODE.set,
                OPCODE.get,
                OPCODE.get,
                OPCODE.set,
                OPCODE.get,
            ]);
            expect(transport.state).to.include({
                power: false,
                fanSpeed: 6,
                heaterEnabled: false,
                targetTemperature: 25,
            });
            transport.settings.forEach(payload => {
                expect(payload.subarray(5, 11).toString("hex")).to.equal("121619010306");
                expect(payload[0] & 6).to.equal(6);
            });
            expect(transport.settings[1][0] & 1).to.equal(0);
            expect(transport.types.filter(type => !type)).to.have.length(8);
        } finally {
            session.close();
        }
    });
    it("does not confirm a SET accepted by GATT but ignored by the device", async () => {
        const transport = new FakeTransport();
        const session = makeSession(transport);
        try {
            await session.initialize();
            transport.ignoreSet = true;
            await rejects(session.update({ power: false }), "did not confirm power");
        } finally {
            session.close();
        }
    });
    it("rejects heating without a heater", async () => {
        const transport = new FakeTransport();
        transport.state.heaterPresent = false;
        transport.state.heaterEnabled = false;
        const session = makeSession(transport);
        try {
            await session.initialize();
            await rejects(session.update({ heaterEnabled: true }), "no heater");
            expect(transport.settings).to.have.length(0);
        } finally {
            session.close();
        }
    });
    it("times out, handles write failure and cancels pending/queued work on disconnect", async () => {
        const transport = new FakeTransport();
        const session = makeSession(transport);
        await session.initialize();
        transport.silent = true;
        await rejects(session.refresh(), "timeout");
        transport.silent = false;
        transport.failWrite = true;
        await rejects(session.refresh(), "write failed");
        transport.failWrite = false;
        transport.silent = true;
        const pending = rejects(session.refresh(), "closed");
        const queued = rejects(session.update({ power: false }), "closed");
        await new Promise(resolve => setTimeout(resolve, 5));
        transport.onDisconnect(new Error("lost connection"));
        await Promise.all([pending, queued]);
        expect(transport.closed).to.equal(true);
    });
});
