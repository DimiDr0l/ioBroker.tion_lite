import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { type Transport, errorText } from "./transport";
import { type HciRequest, isHciMessage } from "./hciIpc";

/** Parent-side transport. Noble and native HCI dependencies are loaded only in a child. */
export class WorkerTransport implements Transport {
    public onData: (data: Buffer) => void = () => {};
    public onDisconnect: (reason: Error) => void = () => {};
    public onDriverState: (state: string) => void = () => {};
    private child?: ChildProcess;
    private closed = false;
    private nextId = 0;
    private readonly pending = new Map<
        number,
        {
            resolve: (identity: { name: string; address: string } | undefined) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout;
        }
    >();

    /**
     * Create an isolated worker transport for one device session.
     *
     * @param address Configured BLE address.
     * @param hci Host HCI controller name.
     * @param spawn Fork implementation, replaceable in offline tests.
     * @param timeout Worker RPC deadline in milliseconds, including startup/discovery.
     */
    public constructor(
        private readonly address: string,
        private readonly hci: string,
        private readonly spawn: typeof fork = fork,
        private readonly timeout = 65000,
    ) {}

    private readonly handleMessage = (message: unknown): void => {
        if (this.closed) {
            return;
        }
        if (!isHciMessage(message)) {
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

    private readonly handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.fail(new Error(`Bluetooth worker exited (${signal ?? code ?? "unknown"})`));
    };

    private readonly handleError = (error: Error): void => this.fail(error);

    private fail(error: Error): void {
        if (this.closed) {
            return;
        }
        this.close(error);
        this.onDriverState("disconnected");
        this.onDisconnect(error);
    }

    private request(
        message: Exclude<HciRequest, { type: "close" }>,
    ): Promise<{ name: string; address: string } | undefined> {
        const child = this.child;
        if (this.closed || !child?.connected) {
            return Promise.reject(new Error("Bluetooth worker is closed"));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error("Bluetooth worker request timed out")), this.timeout);
            this.pending.set(message.id, { resolve, reject, timer });
            child.send(message, error => {
                if (error) {
                    this.fail(new Error(`Bluetooth IPC failed: ${errorText(error)}`));
                }
            });
        });
    }

    /** Fork a worker with the selected HCI, then wait for GATT readiness. */
    public async connect(): Promise<{ name: string; address: string }> {
        if (this.closed || this.child) {
            throw new Error("Bluetooth worker already started or closed");
        }
        if (!/^hci\d+$/.test(this.hci)) {
            throw new Error("Expected an HCI controller name such as hci0");
        }
        const env = { ...process.env, NOBLE_HCI_DEVICE_ID: this.hci.slice(3), NOBLE_BINDINGS: "hci" };
        delete (env as NodeJS.ProcessEnv).HCI_CHANNEL_USER;
        this.child = this.spawn(path.join(__dirname, "..", "hciWorker.js"), [], {
            env,
            execArgv: [],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        this.child.on("message", this.handleMessage);
        this.child.on("exit", this.handleExit);
        this.child.on("error", this.handleError);
        this.child.on("disconnect", () => this.fail(new Error("Bluetooth worker IPC disconnected")));
        // Drain native diagnostic output; the structured IPC error/state is published in ioBroker.
        this.child.stdout?.resume();
        this.child.stderr?.resume();
        const identity = await this.request({
            type: "connect",
            id: ++this.nextId,
            address: this.address,
            hci: this.hci,
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
    public async write(frame: Buffer, withResponse: boolean): Promise<void> {
        await this.request({ type: "write", id: ++this.nextId, hex: frame.toString("hex"), withResponse });
    }

    /**
     * Reject outstanding work and stop the native process, including a force-kill fallback.
     *
     * @param reason Error delivered to outstanding RPC requests.
     */
    public close(reason = new Error("Bluetooth worker closed")): void {
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
        this.child = undefined;
        if (child && child.exitCode === null && child.signalCode === null) {
            child.removeListener("message", this.handleMessage);
            child.kill("SIGTERM");
            const timer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
            }, 2000);
            timer.unref();
            child.once("exit", () => clearTimeout(timer));
        }
    }
}
