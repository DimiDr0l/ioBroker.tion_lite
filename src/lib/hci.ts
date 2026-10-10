import type { Noble, Peripheral, Characteristic } from "@stoprocent/noble";
import type { Transport } from "./transport";
import { UUIDS } from "./protocol";

const uuid = (value: string): string => value.replace(/-/g, "").toLowerCase();

/** Direct Linux HCI access to a dedicated USB Bluetooth controller. */
export class HciTransport implements Transport {
    public onData: (data: Buffer) => void = () => {};
    public onDisconnect: (reason: Error) => void = () => {};
    private noble?: Noble;
    private peripheral?: Peripheral;
    private writer?: Characteristic;
    private notifier?: Characteristic;
    private readonly abort = new AbortController();
    private connected = false;
    private scanning = false;

    /**
     * Configure one native HCI user-channel backend, separate from BlueZ.
     *
     * @param address Uppercase colon-separated breezer MAC address.
     * @param hci Dedicated controller name, such as hci1.
     * @param createNoble Backend factory, injectable in tests.
     * @param operationTimeout Deadline for scan/connect/discovery, in milliseconds.
     */
    public constructor(
        private readonly address: string,
        private readonly hci: string,
        private readonly createNoble: (deviceId: number) => Promise<Noble> = async deviceId => {
            const { withBindings } = await import("@stoprocent/noble");
            return withBindings("hci", { hciDriver: "native", deviceId, userChannel: true });
        },
        private readonly operationTimeout = 20000,
    ) {}

    private readonly handleError = (error: Error): void => {
        if (!this.abort.signal.aborted) {
            this.onDisconnect(error);
        }
    };

    private readonly handleState = (state: string): void => {
        if (this.connected && state !== "poweredOn") {
            this.handleError(new Error(`Bluetooth controller became ${state}`));
        }
    };

    private readonly handleDisconnect = (reason: number | string): void => {
        this.connected = false;
        this.handleError(new Error(`Bluetooth peripheral disconnected (${reason})`));
    };

    private readonly handleData = (data: Buffer, isNotification: boolean): void => {
        if (isNotification && !this.abort.signal.aborted) {
            this.onData(Buffer.from(data));
        }
    };

    private async bounded<T>(operation: () => Promise<T>): Promise<T> {
        if (this.abort.signal.aborted) {
            throw new Error("Bluetooth transport is closed");
        }
        let timer: NodeJS.Timeout | undefined;
        let cancel = (): void => {};
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`HCI operation timed out on ${this.hci}`)),
                this.operationTimeout,
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

    private async waitForController(noble: Noble): Promise<void> {
        // Read the state before adding a stateChange listener: the getter initializes
        // HCI synchronously, so native load/bind exceptions remain catchable here.
        if (noble.state === "poweredOn") {
            return;
        }
        const check = (state: string): void => {
            if (["unsupported", "unauthorized"].includes(state)) {
                throw new Error(
                    `${this.hci} is ${state}; check HCI access permissions and that the dedicated controller is down`,
                );
            }
        };
        check(noble.state);
        let listener = (_state: string): void => {};
        const ready = new Promise<void>((resolve, reject) => {
            listener = state => {
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

    private async findPeripheral(noble: Noble): Promise<Peripheral> {
        let listener = (_peripheral: Peripheral): void => {};
        const discovered = new Promise<Peripheral>(resolve => {
            listener = peripheral => {
                if (peripheral.address?.toUpperCase() === this.address) {
                    resolve(peripheral);
                }
            };
            noble.on("discover", listener);
        });
        this.scanning = true;
        try {
            // Do not require the proprietary service in advertisements; match the MAC.
            const [, peripheral] = await this.bounded(() =>
                Promise.all([noble.startScanningAsync([], false), discovered]),
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
    public async connect(): Promise<{ name: string; address: string }> {
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
                /* Not initialized yet. */
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
        const { characteristics } = await this.bounded(() =>
            peripheral.discoverSomeServicesAndCharacteristicsAsync(
                [uuid(UUIDS.service)],
                [uuid(UUIDS.write), uuid(UUIDS.notify)],
            ),
        );
        this.writer = characteristics.find(item => uuid(item.uuid) === uuid(UUIDS.write));
        this.notifier = characteristics.find(item => uuid(item.uuid) === uuid(UUIDS.notify));
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
        await this.bounded(() => this.notifier!.subscribeAsync());
        this.connected = true;
        return { name: peripheral.advertisement.localName || "Br Lite", address: this.address };
    }

    /**
     * Write using the protocol's required ATT procedure.
     *
     * @param frame BLE value including the fragment marker.
     * @param withResponse True for a single-fragment command.
     */
    public async write(frame: Buffer, withResponse: boolean): Promise<void> {
        if (!this.writer || !this.connected || this.abort.signal.aborted) {
            throw new Error("Bluetooth not connected");
        }
        await this.bounded(() => this.writer!.writeAsync(frame, !withResponse));
    }

    /** Release listeners, connections and the exclusive HCI socket. */
    public close(): void {
        if (this.abort.signal.aborted) {
            return;
        }
        this.abort.abort();
        this.connected = false;
        this.notifier?.removeListener("data", this.handleData);
        this.peripheral?.removeListener("disconnect", this.handleDisconnect);
        this.noble?.removeListener("stateChange", this.handleState);
        // Keep the error handler: native teardown can still emit errors asynchronously.
        try {
            if (this.scanning) {
                this.noble?.stopScanning();
            }
            this.noble?.stop();
        } catch {
            // Partially initialized/removed hardware still needs an idempotent close.
        }
        this.writer = undefined;
    }
}
