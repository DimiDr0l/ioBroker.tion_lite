import { HciTransport } from "./lib/hci";
import { type Transport, errorText } from "./lib/transport";
import type { HciMessage, HciRequest } from "./lib/hciIpc";

/** Protocol-independent worker command handler, injectable for offline GATT tests. */
export class HciWorker {
    private transport?: Transport;
    private queue: Promise<void> = Promise.resolve();
    private closed = false;

    /**
     * Bind worker IPC to a lazily loaded native transport.
     *
     * @param send Structured parent notification callback.
     * @param create Construct the hardware backend only on connect.
     */
    public constructor(
        private readonly send: (message: HciMessage) => void,
        private readonly create: (address: string, hci: string) => Transport = (address, hci) =>
            new HciTransport(address, hci),
    ) {}

    /**
     * Handle one RPC; serialize hardware operations but allow immediate shutdown.
     *
     * @param value Parent request over IPC.
     */
    public receive(value: unknown): void {
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
        if (
            !("id" in value) ||
            !Number.isSafeInteger(value.id) ||
            (value.type !== "connect" && value.type !== "write")
        ) {
            this.send({ type: "fatal", error: "Invalid Bluetooth worker request" });
            this.close();
            return;
        }
        const request = value as HciRequest & { id: number };
        this.queue = this.queue
            .then(async () => {
                if (this.closed) {
                    return;
                }
                try {
                    if (request.type === "connect") {
                        if (
                            typeof request.address !== "string" ||
                            !/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(request.address) ||
                            typeof request.hci !== "string" ||
                            !/^hci\d+$/.test(request.hci) ||
                            this.transport
                        ) {
                            throw new Error("Invalid or duplicate Bluetooth connect request");
                        }
                        const transport = this.create(request.address, request.hci);
                        this.transport = transport;
                        transport.onData = data => this.send({ type: "data", hex: data.toString("hex") });
                        transport.onDriverState = state => this.send({ type: "driverState", state });
                        transport.onDisconnect = error => {
                            this.send({ type: "fatal", error: errorText(error) });
                            this.close();
                        };
                        const identity = await transport.connect();
                        if (!this.closed) {
                            this.send({ type: "response", id: request.id, identity });
                        }
                    } else if (request.type === "write") {
                        if (
                            !this.transport ||
                            typeof request.hex !== "string" ||
                            request.hex.length > 40 ||
                            !/^(?:[\da-f]{2})+$/i.test(request.hex) ||
                            typeof request.withResponse !== "boolean"
                        ) {
                            throw new Error("Invalid Bluetooth write request");
                        }
                        await this.transport.write(Buffer.from(request.hex, "hex"), request.withResponse);
                        if (!this.closed) {
                            this.send({ type: "response", id: request.id });
                        }
                    }
                } catch (error) {
                    if (!this.closed) {
                        this.send({ type: "response", id: request.id, error: errorText(error) });
                    }
                }
            })
            .catch(error => {
                this.send({ type: "fatal", error: errorText(error) });
                this.close();
            });
    }

    /** Cancel hardware activity before the worker process exits. */
    public close(): void {
        if (!this.closed) {
            this.closed = true;
            this.transport?.close();
        }
    }
}

if (require.main === module) {
    const send = (message: HciMessage): void => {
        if (process.connected && process.send) {
            process.send(message, error => {
                if (error) {
                    process.exit(1);
                }
            });
        }
    };
    const worker = new HciWorker(send);
    const stop = (): void => {
        worker.close();
        process.exit(0);
    };
    const fatal = (error: unknown): void => {
        send({ type: "fatal", error: errorText(error) });
        worker.close();
        // Give IPC a short opportunity to deliver diagnostics, then exit even if native cleanup hangs.
        setTimeout(() => process.exit(1), 50);
    };
    process.on("message", value => worker.receive(value));
    process.on("disconnect", stop);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.on("uncaughtException", fatal);
    process.on("unhandledRejection", fatal);
}
