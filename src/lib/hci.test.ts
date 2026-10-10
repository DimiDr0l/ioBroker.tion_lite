/* eslint-disable @typescript-eslint/require-await -- Fake BLE methods implement Noble's asynchronous API. */
import { EventEmitter } from "node:events";
import { describe, it } from "mocha";
import { expect } from "chai";
import type { Noble } from "@stoprocent/noble";
import { HciTransport } from "./hci";
import { UUIDS } from "./protocol";

class FakeCharacteristic extends EventEmitter {
    public properties = ["write", "writeWithoutResponse", "notify"];
    public writes: { frame: Buffer; withoutResponse: boolean }[] = [];
    public subscribed = false;
    public constructor(public uuid: string) {
        super();
    }
    public async subscribeAsync(): Promise<void> {
        this.subscribed = true;
    }
    public async writeAsync(frame: Buffer, withoutResponse: boolean): Promise<void> {
        this.writes.push({ frame: Buffer.from(frame), withoutResponse });
    }
}
class FakePeripheral extends EventEmitter {
    public address = "aa:bb:cc:dd:ee:ff";
    public advertisement = { localName: "Br Lite USB" };
    public writer = new FakeCharacteristic(UUIDS.write.replace(/-/g, ""));
    public notifier = new FakeCharacteristic(UUIDS.notify.replace(/-/g, ""));
    public connected = false;
    public filters?: string[][];
    public async connectAsync(): Promise<void> {
        this.connected = true;
    }
    public async discoverSomeServicesAndCharacteristicsAsync(
        services: string[],
        characteristics: string[],
    ): Promise<{
        characteristics: FakeCharacteristic[];
    }> {
        this.filters = [services, characteristics];
        return { characteristics: [this.writer, this.notifier] };
    }
}
class FakeNoble extends EventEmitter {
    public state = "poweredOn";
    public peripheral = new FakePeripheral();
    public scanning = false;
    public stopped = false;
    public silent = false;
    public async startScanningAsync(): Promise<void> {
        this.scanning = true;
        if (!this.silent) {
            this.emit("discover", { address: "00:00:00:00:00:00" });
            this.emit("discover", this.peripheral);
        }
    }
    public async stopScanningAsync(): Promise<void> {
        this.scanning = false;
    }
    public stopScanning(): void {
        this.scanning = false;
    }
    public stop(): void {
        this.stopped = true;
    }
}

async function withTransport(test: (transport: HciTransport, noble: FakeNoble) => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    const noble = new FakeNoble();
    const transport = new HciTransport(
        "AA:BB:CC:DD:EE:FF",
        "hci1",
        async id => {
            expect(id).to.equal(1);
            return noble as unknown as Noble;
        },
        30,
    );
    try {
        await test(transport, noble);
    } finally {
        transport.close();
        Object.defineProperty(process, "platform", original);
    }
}

describe("Direct USB-controller HCI transport", () => {
    it("matches the MAC, scopes GATT, subscribes and uses correct ATT write types", async () => {
        await withTransport(async (transport, noble) => {
            expect(await transport.connect()).to.deep.equal({ name: "Br Lite USB", address: "AA:BB:CC:DD:EE:FF" });
            expect(noble.scanning).to.equal(false);
            expect(noble.peripheral.filters?.[0]).to.deep.equal([UUIDS.service.replace(/-/g, "")]);
            expect(noble.peripheral.notifier.subscribed).to.equal(true);
            await transport.write(Buffer.from([0x80, 1]), true);
            await transport.write(Buffer.from([0, 2]), false);
            expect(noble.peripheral.writer.writes.map(item => item.withoutResponse)).to.deep.equal([false, true]);
            let received: Buffer | undefined;
            transport.onData = data => {
                received = data;
            };
            noble.peripheral.notifier.emit("data", Buffer.from([0x80, 3]), false);
            expect(received).to.equal(undefined);
            noble.peripheral.notifier.emit("data", Buffer.from([0x80, 3]), true);
            expect(received).to.deep.equal(Buffer.from([0x80, 3]));
            transport.close();
            transport.close();
            expect(noble.stopped).to.equal(true);
            expect(noble.listenerCount("discover")).to.equal(0);
            expect(noble.listenerCount("stateChange")).to.equal(0);
            expect(noble.peripheral.notifier.listenerCount("data")).to.equal(0);
            expect(noble.peripheral.listenerCount("disconnect")).to.equal(0);
        });
    });
    it("reports unplugged controllers and peripheral disconnects", async () => {
        await withTransport(async (transport, noble) => {
            await transport.connect();
            const errors: string[] = [];
            transport.onDisconnect = error => {
                errors.push(error.message);
            };
            noble.emit("stateChange", "poweredOff");
            noble.peripheral.emit("disconnect", 19);
            expect(errors[0]).to.contain("poweredOff");
            expect(errors[1]).to.contain("19");
            transport.close();
            noble.emit("error", new Error("late native teardown error"));
            expect(errors).to.have.length(2);
        });
    });
    it("times out scanning, stops scanning, and rejects unsupported controllers", async () => {
        await withTransport(async (transport, noble) => {
            noble.silent = true;
            let failure: unknown;
            try {
                await transport.connect();
            } catch (error) {
                failure = error;
            }
            expect((failure as Error).message).to.contain("timed out");
            expect(noble.scanning).to.equal(false);
            expect(noble.listenerCount("discover")).to.equal(0);
        });
        await withTransport(async (transport, noble) => {
            noble.state = "unsupported";
            let failure: unknown;
            try {
                await transport.connect();
            } catch (error) {
                failure = error;
            }
            expect((failure as Error).message).to.contain("check HCI access");
        });
    });
    it("cancels an in-flight scan on shutdown and removes its listener", async () => {
        await withTransport(async (transport, noble) => {
            noble.silent = true;
            const operation = transport.connect().catch(error => error as Error);
            await new Promise(resolve => setTimeout(resolve, 5));
            transport.close();
            expect(((await operation) as Error).message).to.contain("closed");
            expect(noble.listenerCount("discover")).to.equal(0);
            expect(noble.stopped).to.equal(true);
        });
    });
});
