/* eslint-disable @typescript-eslint/require-await -- Test doubles implement asynchronous transport methods. */
import { EventEmitter } from "node:events";
import type { ChildProcess, fork } from "node:child_process";
import { describe, it } from "mocha";
import { expect } from "chai";
import { WorkerTransport } from "./workerTransport";
import { HciWorker } from "../hciWorker";
import { loadNoble } from "./hci";
import { isHciMessage, type HciMessage, type HciRequest } from "./hciIpc";
import type { Noble } from "@stoprocent/noble";
import type { Transport } from "./transport";

class FakeChild extends EventEmitter {
    public connected = true;
    public exitCode: number | null = null;
    public signalCode: NodeJS.Signals | null = null;
    public requests: HciRequest[] = [];
    public autoReply = true;
    public kills: string[] = [];
    public send(request: HciRequest, callback: (error: Error | null) => void): boolean {
        this.requests.push(request);
        if (this.autoReply && request.type !== "close") {
            const response: HciMessage =
                request.type === "connect"
                    ? {
                          type: "response",
                          id: request.id,
                          identity: { name: "Br Lite child", address: request.address },
                      }
                    : { type: "response", id: request.id };
            this.emit("message", response);
        }
        callback(null);
        return true;
    }
    public kill(signal: string): boolean {
        this.kills.push(signal);
        this.connected = false;
        this.signalCode = signal as NodeJS.Signals;
        setImmediate(() => this.emit("exit", null, signal));
        return true;
    }
}

async function rejection(operation: Promise<unknown>, text: string): Promise<void> {
    let error: unknown;
    try {
        await operation;
    } catch (failure) {
        error = failure;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(text);
}

function pair(timeout = 50): { child: FakeChild; transport: WorkerTransport } {
    const child = new FakeChild();
    const spawn = ((_file: string, _args: string[], options: { env: NodeJS.ProcessEnv; execArgv: string[] }) => {
        expect(_file).to.match(/hciWorker\.js$/);
        expect(options.env.NOBLE_HCI_DEVICE_ID).to.equal("1");
        expect(options.env.HCI_CHANNEL_USER).to.equal(undefined);
        expect(options.execArgv).to.deep.equal([]);
        return child as unknown as ChildProcess;
    }) as typeof fork;
    return { child, transport: new WorkerTransport("AA:BB:CC:DD:EE:FF", "hci1", spawn, timeout) };
}

class FakeBackend implements Transport {
    public onData = (_data: Buffer): void => {};
    public onDisconnect = (_error: Error): void => {};
    public onDriverState = (_state: string): void => {};
    public writes: { hex: string; withResponse: boolean }[] = [];
    public closed = false;
    public async connect(): Promise<{ name: string; address: string }> {
        this.onDriverState("poweredOn");
        return { name: "Br Lite GATT", address: "AA:BB:CC:DD:EE:FF" };
    }
    public async write(data: Buffer, withResponse: boolean): Promise<void> {
        this.writes.push({ hex: data.toString("hex"), withResponse });
        this.onData(Buffer.from([0x80, 0x12]));
    }
    public close(): void {
        this.closed = true;
    }
}

describe("Noble loading compatible with ioBroker.ble", () => {
    it("sets HCI selection before importing and accepts a singleton", async () => {
        const env = { ...process.env };
        try {
            process.env.HCI_CHANNEL_USER = "1";
            const noble = new EventEmitter() as Noble;
            const result = await loadNoble(2, async () => {
                expect(process.env.NOBLE_HCI_DEVICE_ID).to.equal("2");
                expect(process.env.NOBLE_BINDINGS).to.equal("hci");
                expect(process.env.HCI_CHANNEL_USER).to.equal(undefined);
                return { default: noble };
            });
            expect(result).to.equal(noble);
        } finally {
            process.env = env;
        }
    });
    it("accepts the older factory export and reports native load failures", async () => {
        const env = { ...process.env };
        try {
            const noble = new EventEmitter() as Noble;
            expect(
                await loadNoble(0, async () => (options: { extended: boolean }) => {
                    expect(options).to.deep.equal({ extended: false });
                    return noble;
                }),
            ).to.equal(noble);
            await rejection(
                loadNoble(0, async () => {
                    throw new Error("NODE_MODULE_VERSION mismatch");
                }),
                "NODE_MODULE_VERSION",
            );
            await rejection(
                loadNoble(0, async () => ({})),
                "expected a Noble",
            );
        } finally {
            process.env = env;
        }
    });
});

describe("Isolated Bluetooth parent transport", () => {
    it("forwards identity, notifications, controller state and write procedure over IPC", async () => {
        const { child, transport } = pair();
        try {
            expect(await transport.connect()).to.deep.equal({ name: "Br Lite child", address: "AA:BB:CC:DD:EE:FF" });
            await transport.write(Buffer.from([0, 0x12]), false);
            await transport.write(Buffer.from([0x80, 0x34]), true);
            expect(child.requests.slice(1)).to.deep.equal([
                { type: "write", id: 2, hex: "0012", withResponse: false },
                { type: "write", id: 3, hex: "8034", withResponse: true },
            ]);
            let received: Buffer | undefined;
            let state = "";
            transport.onData = data => {
                received = data;
            };
            transport.onDriverState = value => {
                state = value;
            };
            child.emit("message", { type: "data", hex: "8012" });
            child.emit("message", { type: "driverState", state: "unauthorized" });
            expect(received).to.deep.equal(Buffer.from([0x80, 0x12]));
            expect(state).to.equal("unauthorized");
            transport.close();
            transport.close();
            expect(child.kills).to.deep.equal(["SIGTERM"]);
        } finally {
            transport.close();
        }
    });
    it("rejects pending work after a native crash and ignores late messages", async () => {
        const { child, transport } = pair();
        await transport.connect();
        child.autoReply = false;
        let failures = 0;
        transport.onDisconnect = () => {
            failures++;
        };
        const pending = rejection(transport.write(Buffer.from([0x80]), true), "SIGSEGV");
        child.signalCode = "SIGSEGV";
        child.emit("exit", null, "SIGSEGV");
        await pending;
        child.emit("message", { type: "fatal", error: "late failure" });
        expect(failures).to.equal(1);
        await rejection(transport.write(Buffer.from([0x80]), true), "closed");
    });
    it("reports IPC loss, malformed messages and hung workers; planned close is quiet", async () => {
        for (const mode of ["timeout", "invalid", "disconnect", "close"]) {
            const { child, transport } = pair(10);
            await transport.connect();
            child.autoReply = false;
            let failures = 0;
            transport.onDisconnect = () => {
                failures++;
            };
            const pending = rejection(
                transport.write(Buffer.from([0x80]), true),
                mode === "timeout"
                    ? "timed out"
                    : mode === "invalid"
                      ? "Invalid"
                      : mode === "close"
                        ? "closed"
                        : "disconnected",
            );
            if (mode === "invalid") {
                child.emit("message", { type: "data", hex: "xyz" });
            }
            if (mode === "disconnect") {
                child.emit("disconnect");
            }
            if (mode === "close") {
                transport.close();
            }
            await pending;
            expect(failures).to.equal(mode === "close" ? 0 : 1);
            expect(child.kills).to.deep.equal(["SIGTERM"]);
        }
    });
});

describe("Bluetooth worker GATT command handler", () => {
    it("serializes hardware operations, publishes data and shuts down on loss of hardware", async () => {
        const backend = new FakeBackend();
        const messages: HciMessage[] = [];
        const worker = new HciWorker(
            message => messages.push(message),
            () => backend,
        );
        worker.receive({ type: "connect", id: 1, address: "AA:BB:CC:DD:EE:FF", hci: "hci1" });
        worker.receive({ type: "write", id: 2, hex: "801234", withResponse: true });
        worker.receive({ type: "write", id: 3, hex: "001234", withResponse: false });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(backend.writes).to.deep.equal([
            { hex: "801234", withResponse: true },
            { hex: "001234", withResponse: false },
        ]);
        expect(messages.filter(message => message.type === "response").map(message => message.id)).to.deep.equal([
            1, 2, 3,
        ]);
        expect(messages).to.deep.include({ type: "driverState", state: "poweredOn" });
        expect(messages).to.deep.include({ type: "data", hex: "8012" });
        backend.onDisconnect(new Error("controller removed"));
        expect(messages).to.deep.include({ type: "fatal", error: "controller removed" });
        expect(backend.closed).to.equal(true);
    });
    it("rejects missing, duplicate or oversized hardware requests", async () => {
        const messages: HciMessage[] = [];
        const worker = new HciWorker(
            message => messages.push(message),
            () => new FakeBackend(),
        );
        worker.receive({ type: "write", id: 1, hex: "80", withResponse: true });
        worker.receive({ type: "connect", id: 2, address: "AA:BB:CC:DD:EE:FF", hci: "hci0" });
        worker.receive({ type: "connect", id: 3, address: "AA:BB:CC:DD:EE:FF", hci: "hci0" });
        worker.receive({ type: "write", id: 4, hex: "80".repeat(21), withResponse: true });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(messages.filter(message => message.type === "response" && message.error)).to.have.length(3);
        worker.close();
        expect(isHciMessage({ type: "response", id: 1, identity: {} })).to.equal(false);
        expect(isHciMessage({ type: "data", hex: "123" })).to.equal(false);
    });
});
