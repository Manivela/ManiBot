const mockSentryCaptureException = jest.fn();

jest.mock("@sentry/node", () => ({
  captureException: (...args) => mockSentryCaptureException(...args),
}));

const REST_URL = "https://example.upstash.io";
const REST_TOKEN = "test-token";

const loadStore = () => require("../src/music/volumeStore");

const mockFetchResult = (result) =>
  jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ result }) }),
  );

describe("volumeStore", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.MANIBOT_VOLUME_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  const enable = () => {
    process.env.UPSTASH_REDIS_REST_URL = REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = REST_TOKEN;
  };

  describe("isEnabled", () => {
    it("is false when credentials are missing", () => {
      expect(loadStore().isEnabled()).toBe(false);
    });

    it("is false when only one credential is set", () => {
      process.env.UPSTASH_REDIS_REST_URL = REST_URL;
      expect(loadStore().isEnabled()).toBe(false);
    });

    it("is true when both credentials are set", () => {
      enable();
      expect(loadStore().isEnabled()).toBe(true);
    });
  });

  describe("load", () => {
    it("returns an empty Map without calling fetch when disabled", async () => {
      global.fetch = jest.fn();
      const store = loadStore();

      const result = await store.load();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("parses a flat HGETALL array into a Map of finite numbers", async () => {
      enable();
      global.fetch = mockFetchResult(["guild-1", "0.7", "guild-2", "1.25"]);
      const store = loadStore();

      const result = await store.load();

      expect(global.fetch).toHaveBeenCalledWith(REST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["HGETALL", "manibot:volumes"]),
        signal: expect.any(AbortSignal),
      });
      expect([...result.entries()]).toEqual([
        ["guild-1", 0.7],
        ["guild-2", 1.25],
      ]);
    });

    it("drops non-numeric stored values", async () => {
      enable();
      global.fetch = mockFetchResult(["guild-1", "loud", "guild-2", "0.5"]);

      const result = await loadStore().load();

      expect([...result.entries()]).toEqual([["guild-2", 0.5]]);
    });

    it("tolerates an object-shaped HGETALL response", async () => {
      enable();
      global.fetch = mockFetchResult({ "guild-1": "0.4" });

      const result = await loadStore().load();

      expect([...result.entries()]).toEqual([["guild-1", 0.4]]);
    });

    it("honors a custom MANIBOT_VOLUME_KEY", async () => {
      enable();
      process.env.MANIBOT_VOLUME_KEY = "custom:key";
      global.fetch = mockFetchResult([]);

      await loadStore().load();

      expect(global.fetch).toHaveBeenCalledWith(
        REST_URL,
        expect.objectContaining({
          body: JSON.stringify(["HGETALL", "custom:key"]),
        }),
      );
    });

    it("returns an empty Map and reports when fetch rejects", async () => {
      enable();
      global.fetch = jest.fn(() => Promise.reject(new Error("network down")));

      const result = await loadStore().load();

      expect(result.size).toBe(0);
      expect(mockSentryCaptureException).toHaveBeenCalled();
    });

    it("returns an empty Map on a non-ok response", async () => {
      enable();
      global.fetch = jest.fn(() =>
        Promise.resolve({ ok: false, status: 500, json: () => ({}) }),
      );

      const result = await loadStore().load();

      expect(result.size).toBe(0);
      expect(mockSentryCaptureException).toHaveBeenCalled();
    });

    it("returns an empty Map when the payload carries an error", async () => {
      enable();
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ error: "WRONGTYPE" }),
        }),
      );

      const result = await loadStore().load();

      expect(result.size).toBe(0);
      expect(mockSentryCaptureException).toHaveBeenCalled();
    });
  });

  describe("save", () => {
    it("does nothing without calling fetch when disabled", async () => {
      global.fetch = jest.fn();

      await loadStore().save("guild-1", 0.7);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("issues an HSET with the guild id and volume", async () => {
      enable();
      global.fetch = mockFetchResult(1);

      await loadStore().save("guild-1", 0.7);

      expect(global.fetch).toHaveBeenCalledWith(REST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["HSET", "manibot:volumes", "guild-1", "0.7"]),
        signal: expect.any(AbortSignal),
      });
    });

    it("resolves and reports when the request fails", async () => {
      enable();
      global.fetch = jest.fn(() => Promise.reject(new Error("network down")));

      await expect(loadStore().save("guild-1", 0.7)).resolves.toBeUndefined();
      expect(mockSentryCaptureException).toHaveBeenCalled();
    });
  });
});
