import { setTimeout as delay } from "node:timers/promises";
import type { Transport } from "./transport";
import {
    type Controls,
    type DeviceInfo,
    type LiteState,
    FrameAssembler,
    OPCODE,
    decodeInfo,
    decodeState,
    encodeCommand,
    encodeSettings,
    fragment,
    validateControls,
} from "./protocol";

/** Observed data and lifecycle events belonging to a single connection. */
export interface SessionCallbacks {
    /** Reports validated device state, including unsolicited notifications. */
    state(state: LiteState): void;
    /** Reports decoded firmware information. */
    info(info: DeviceInfo): void;
    /** Reports discarded notifications without acknowledging a command. */
    invalid(error: Error): void;
    /** Reports a closed session after transport failure. */
    disconnected(error: Error): void;
}

/** One outstanding command; ID layout of responses still needs hardware verification. */
export class LiteSession {
    private readonly assembler = new FrameAssembler();
    private readonly abort = new AbortController();
    private queue: Promise<unknown> = Promise.resolve();
    private waiter?: { opcode: number; resolve: (data: Buffer) => void; reject: (error: Error) => void };
    private latest?: LiteState;

    /**
     * Bind protocol processing to a transport.
     *
     * @param transport BLE backend.
     * @param callbacks Connection-scoped observer callbacks.
     * @param responseTimeout Device response deadline in milliseconds.
     * @param readbackDelay Delay after SET before the verification GET.
     */
    public constructor(
        private readonly transport: Transport,
        private readonly callbacks: SessionCallbacks,
        private readonly responseTimeout = 3000,
        private readonly readbackDelay = 1500,
    ) {
        transport.onData = data => this.receive(data);
        transport.onDisconnect = error => {
            this.close();
            callbacks.disconnected(error);
        };
    }

    private receive(data: Buffer): void {
        if (this.abort.signal.aborted) {
            return;
        }
        try {
            const message = this.assembler.push(data);
            if (!message) {
                return;
            }
            const opcode = message.readUInt16LE(4);
            if (opcode === OPCODE.state) {
                this.latest = decodeState(message);
                this.callbacks.state(this.latest);
            } else if (opcode === OPCODE.infoResponse) {
                this.callbacks.info(decodeInfo(message));
            }
            if (this.waiter?.opcode === opcode) {
                this.waiter.resolve(message);
            }
        } catch (error) {
            this.callbacks.invalid(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const operation = this.queue.then(() => {
            if (this.abort.signal.aborted) {
                throw new Error("Device session is closed");
            }
            return job();
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    private async send(opcode: number, payload?: Buffer): Promise<void> {
        const frames = fragment(encodeCommand(opcode, payload));
        for (const frame of frames) {
            if (this.abort.signal.aborted) {
                throw new Error("Device session is closed");
            }
            await this.transport.write(frame, frames.length === 1);
            if (frames.length > 1) {
                await delay(3, undefined, { signal: this.abort.signal });
            }
        }
    }

    private async request(opcode: number, response: number): Promise<Buffer> {
        let timer: NodeJS.Timeout | undefined;
        const result = new Promise<Buffer>((resolve, reject) => {
            this.waiter = { opcode: response, resolve, reject };
            timer = setTimeout(
                () => reject(new Error(`Response timeout for 0x${opcode.toString(16)}`)),
                this.responseTimeout,
            );
        });
        // Install the receiver before writing; transport errors reject the same promise.
        const sending = this.send(opcode);
        try {
            const [message] = await Promise.all([result, sending]);
            return message;
        } finally {
            clearTimeout(timer);
            this.waiter = undefined;
        }
    }

    /** Establish notifications and obtain firmware plus the first configuration. */
    public initialize(): Promise<{ name: string; address: string }> {
        return this.enqueue(async () => {
            const identity = await this.transport.connect();
            await this.request(OPCODE.info, OPCODE.infoResponse);
            await this.request(OPCODE.get, OPCODE.state);
            return identity;
        });
    }

    /** Queue one state query behind all current operations. */
    public refresh(): Promise<void> {
        return this.enqueue(async () => {
            await this.request(OPCODE.get, OPCODE.state);
        });
    }

    /**
     * Preserve a fresh configuration, apply changes and verify actual readback.
     *
     * @param patch Writable fields requested by the user.
     */
    public update(patch: Partial<Controls>): Promise<void> {
        return this.enqueue(async () => {
            validateControls(patch);
            // Fetch fresh presets and indication flags before a whole-configuration write.
            await this.request(OPCODE.get, OPCODE.state);
            if (!this.latest) {
                throw new Error("No confirmed device configuration");
            }
            const next = { ...this.latest, fanSpeed: this.latest.fanSpeed === 0 ? 1 : this.latest.fanSpeed, ...patch };
            if (next.heaterEnabled && !next.heaterPresent) {
                throw new Error("Device reports no heater");
            }
            await this.send(OPCODE.set, encodeSettings(next));
            await delay(this.readbackDelay, undefined, { signal: this.abort.signal });
            const readback = decodeState(await this.request(OPCODE.get, OPCODE.state));
            for (const key of Object.keys(patch) as (keyof Controls)[]) {
                if (readback[key] !== next[key]) {
                    throw new Error(`Device did not confirm ${key}: requested ${next[key]}, received ${readback[key]}`);
                }
            }
        });
    }

    /** Abort outstanding operations and prevent queued commands from replaying. */
    public close(): void {
        if (this.abort.signal.aborted) {
            return;
        }
        this.abort.abort();
        this.waiter?.reject(new Error("Device session closed"));
        this.assembler.reset();
        this.latest = undefined;
        this.transport.close();
    }
}
