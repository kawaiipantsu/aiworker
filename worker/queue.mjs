import net from "node:net";
export class Beanstalk {
  constructor(config) {
    this.config = config;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.socket = null;
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.buffer = Buffer.alloc(0);
    this.socket = net.createConnection(this.config);
    this.socket.on("data", (b) => {
      this.buffer = Buffer.concat([this.buffer, b]);
      this.wake();
    });
    this.socket.on("error", (e) => this.wake(e));
    this.socket.on("close", () =>
      this.wake(new Error("Queue connection closed")),
    );
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.close();
        reject(new Error("Queue connect timeout"));
      }, 3000);
      this.socket.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      this.socket.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    await this.command("use " + this.config.tube);
    await this.command("watch " + this.config.tube);
    await this.command("ignore default");
  }
  wake(error) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      error ? w.reject(error) : w.resolve();
    }
  }
  async more() {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        this.close();
        reject(new Error("Queue response timeout"));
      }, 4000);
      this.waiter = {
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });
  }
  async line() {
    while (true) {
      const i = this.buffer.indexOf("\r\n");
      if (i >= 0) {
        const l = this.buffer.subarray(0, i).toString();
        this.buffer = this.buffer.subarray(i + 2);
        return l;
      }
      await this.more();
    }
  }
  async bytes(n) {
    while (this.buffer.length < n) await this.more();
    const b = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return b;
  }
  async command(cmd, body) {
    if (!this.socket || this.socket.destroyed)
      throw new Error("Queue disconnected");
    this.socket.write(cmd + "\r\n");
    if (body !== undefined)
      this.socket.write(
        Buffer.concat([Buffer.from(body), Buffer.from("\r\n")]),
      );
    return this.line();
  }
  async put(id) {
    const body = JSON.stringify({ id });
    const r = await this.command(
      `put 1024 0 60 ${Buffer.byteLength(body)}`,
      body,
    );
    if (!r.startsWith("INSERTED ")) throw new Error(r);
  }
  async reserve() {
    const line = await this.command("reserve-with-timeout 0");
    if (line === "TIMED_OUT") return null;
    const m = line.match(/^RESERVED (\d+) (\d+)$/);
    if (!m) throw new Error(line);
    const b = await this.bytes(Number(m[2]) + 2);
    return { queueId: m[1], body: b.subarray(0, -2).toString() };
  }
  async delete(id) {
    const r = await this.command("delete " + id);
    if (r !== "DELETED" && r !== "NOT_FOUND") throw new Error(r);
  }
  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}
