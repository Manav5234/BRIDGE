import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BridgeSettings, type ServiceState } from "../src/config";

const { makeMock, FakeClientError, FakeUnauthorizedError } = vi.hoisted(() => {
  class FakeClientError extends Error {
    readonly reason: string;
    constructor(reason: string, options?: { cause?: unknown; detail?: string }) {
      super(`${reason}: fetch failed`);
      this.reason = reason;
      if (options?.cause) this.cause = options.cause;
    }
  }
  class FakeUnauthorizedError extends Error {
    constructor() {
      super("Authentication required");
      this.name = "UnauthorizedError";
    }
  }
  return { makeMock: vi.fn(), FakeClientError, FakeUnauthorizedError };
});

vi.mock("@opencode/client", () => ({
  OpenCode: { make: makeMock },
  ClientError: FakeClientError,
  isUnauthorizedError: (value: unknown) => value instanceof FakeUnauthorizedError,
}));

const { ConnectionManager } = await import("../src/opencode/connection");

const settings = (overrides: Partial<BridgeSettings> = {}): BridgeSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

const state = (overrides: Partial<ServiceState> = {}): ServiceState => ({
  url: "http://127.0.0.1:45278",
  password: "generated-password",
  pid: 123,
  version: "2.0.30",
  source: "C:/state/service.json",
  ...overrides,
});

function clientWithInfo(info: () => Promise<unknown>) {
  return { server: { info } };
}

beforeEach(() => {
  makeMock.mockReset();
});

describe("connecting to OpenCode", () => {
  it("reports the server version and where the address came from", async () => {
    makeMock.mockReturnValue(
      clientWithInfo(async () => ({ version: "2.0.30", pid: 1, urls: [], paths: { tmp: "/tmp" } })),
    );
    const manager = new ConnectionManager(() => settings(), () => state());

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("connected");
    expect(snapshot.version).toBe("2.0.30");
    expect(snapshot.source).toBe("service-state");
    expect(snapshot.baseUrl).toBe("http://127.0.0.1:45278");
    expect(snapshot.message).toBeUndefined();
    expect(manager.client()).toBeDefined();
  });

  it("sends HTTP Basic credentials built from the discovered password", async () => {
    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "2.0.30" })));
    const manager = new ConnectionManager(() => settings(), () => state({ password: "abc123" }));

    await manager.connect();

    const options = makeMock.mock.calls[0]?.[0] as { baseUrl: string; headers: Record<string, string> };
    expect(options.baseUrl).toBe("http://127.0.0.1:45278");
    expect(options.headers.Authorization).toBe(
      "Basic " + Buffer.from("opencode:abc123").toString("base64"),
    );
  });

  it("surfaces an authentication failure with credential guidance", async () => {
    makeMock.mockReturnValue(
      clientWithInfo(async () => {
        throw new FakeUnauthorizedError();
      }),
    );
    const manager = new ConnectionManager(() => settings(), () => state());

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("rejected");
    expect(snapshot.guidance).toContain("bridge.password");
    expect(() => manager.client()).toThrow();
  });

  it("explains that nothing is listening when the server is down", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:45278"), { code: "ECONNREFUSED" });
    makeMock.mockReturnValue(
      clientWithInfo(async () => {
        throw new FakeClientError("Transport", { cause });
      }),
    );
    const manager = new ConnectionManager(() => settings(), () => state());

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("Nothing is listening");
    expect(snapshot.guidance).toContain("opencode service start");
  });

  it("reports a timeout as a timeout, not a crash", async () => {
    makeMock.mockReturnValue(
      clientWithInfo(
        (async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
        }) as () => Promise<unknown>,
      ),
    );
    const manager = new ConnectionManager(() => settings({ requestTimeoutMs: 25 }), () => state());

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toContain("Timed out");
  });

  it("gives setup instructions when OpenCode is not installed or never started", async () => {
    const manager = new ConnectionManager(() => settings(), () => undefined);

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("disconnected");
    expect(snapshot.message).toContain("No OpenCode server found");
    expect(snapshot.guidance).toContain("opencode service start");
    expect(makeMock).not.toHaveBeenCalled();
  });

  it("warns but still connects to a server that is not OpenCode 2.x", async () => {
    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "1.4.0" })));
    const manager = new ConnectionManager(() => settings(), () => state());

    const snapshot = await manager.connect();

    expect(snapshot.status).toBe("connected");
    expect(snapshot.message).toContain("Bridge targets OpenCode 2.x");
  });

  it("mentions a user-configured URL when that URL fails", async () => {
    makeMock.mockReturnValue(
      clientWithInfo(async () => {
        throw new FakeClientError("Transport", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
      }),
    );
    const manager = new ConnectionManager(
      () => settings({ serverUrl: "http://127.0.0.1:9999" }),
      () => undefined,
    );

    const snapshot = await manager.connect();

    expect(snapshot.guidance).toContain("http://127.0.0.1:9999");
  });

  it("never leaks the password into a failure message", async () => {
    const password = "super-secret-password-value";
    makeMock.mockReturnValue(
      clientWithInfo(async () => {
        const error = new Error(`request failed with password ${password}`);
        throw error;
      }),
    );
    const manager = new ConnectionManager(() => settings(), () => state({ password }));

    const snapshot = await manager.connect();

    expect(snapshot.message).not.toContain(password);
    expect(manager.redactableSecrets()).toContain(password);
  });
});

describe("repeated connect attempts", () => {
  it("deduplicates overlapping connects from repeated clicks", async () => {
    let resolveInfo: (value: unknown) => void = () => undefined;
    makeMock.mockReturnValue(
      clientWithInfo(
        () =>
          new Promise((resolve) => {
            resolveInfo = resolve;
          }),
      ),
    );
    const manager = new ConnectionManager(() => settings(), () => state());

    const first = manager.connect();
    const second = manager.connect();
    const third = manager.connect();

    expect(makeMock).toHaveBeenCalledTimes(1);
    resolveInfo({ version: "2.0.30" });

    const results = await Promise.all([first, second, third]);
    expect(results.map((snapshot) => snapshot.status)).toEqual(["connected", "connected", "connected"]);
  });

  it("can reconnect after a failure", async () => {
    makeMock.mockReturnValueOnce(
      clientWithInfo(async () => {
        throw new FakeClientError("Transport", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
      }),
    );
    const manager = new ConnectionManager(() => settings(), () => state());

    expect((await manager.connect()).status).toBe("error");

    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "2.0.30" })));
    expect((await manager.connect()).status).toBe("connected");
  });
});

describe("disconnecting", () => {
  it("drops the client and returns to a clean state", async () => {
    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "2.0.30" })));
    const manager = new ConnectionManager(() => settings(), () => state());
    await manager.connect();

    manager.reset();

    expect(manager.snapshot()).toEqual({ status: "disconnected" });
    expect(() => manager.client()).toThrow();
  });

  it("reports a lost connection once a request fails after connecting", async () => {
    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "2.0.30" })));
    const manager = new ConnectionManager(() => settings(), () => state());
    await manager.connect();

    const reason = manager.noteTransportFailure(new FakeClientError("Transport"));

    expect(reason).toContain("Cannot reach");
    expect(manager.snapshot().status).toBe("error");
  });

  it("does not downgrade the connection for a non-transport error", async () => {
    makeMock.mockReturnValue(clientWithInfo(async () => ({ version: "2.0.30" })));
    const manager = new ConnectionManager(() => settings(), () => state());
    await manager.connect();

    manager.noteTransportFailure(new Error("session not found"));

    expect(manager.snapshot().status).toBe("connected");
  });
});
