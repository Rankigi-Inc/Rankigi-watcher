import type { App } from "obsidian";
import { WatcherChain } from "../chain/chain";
import { RankigiWatcherSettings } from "../settings";
import {
  buildDomainAllowlist,
  resolvePluginFromStack,
} from "../attribution";

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;
type XhrOpenFn = (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null
) => void;
type XhrSendFn = (
  this: XMLHttpRequest,
  body?: Document | XMLHttpRequestBodyInit | null
) => void;

interface ObsidianModule {
  requestUrl?: unknown;
  [key: string]: unknown;
}

interface RequestUrlParamLike {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface XhrMeta {
  _rw_method?: string;
  _rw_url?: string;
  _rw_skip?: boolean;
}

const SELF_HEADER = "x-rankigi-watcher";

function hasSelfHeader(init?: RequestInit): boolean {
  if (!init || !init.headers) return false;
  const h = init.headers;
  if (h instanceof Headers) return h.has(SELF_HEADER);
  if (Array.isArray(h)) {
    return h.some(
      ([k]) => typeof k === "string" && k.toLowerCase() === SELF_HEADER
    );
  }
  if (typeof h === "object") {
    return Object.keys(h as Record<string, string>).some(
      (k) => k.toLowerCase() === SELF_HEADER
    );
  }
  return false;
}

function extractFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function extractFetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit
): string {
  if (init && typeof init.method === "string") return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function urlString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return null;
}

export class NetworkMonitor {
  private origFetch: FetchFn | null = null;
  private wrappedFetchRef: FetchFn | null = null;
  private origXhrOpen: XhrOpenFn | null = null;
  private origXhrSend: XhrSendFn | null = null;
  private wrappedXhrOpenRef: XhrOpenFn | null = null;
  private wrappedXhrSendRef: XhrSendFn | null = null;
  private origRequestUrl: unknown = null;
  private obsModule: ObsidianModule | null = null;
  private domainAllowlist: Set<string> = new Set();
  private running = false;
  private pendingChain: Promise<unknown> = Promise.resolve();
  private xhrCtor: typeof XMLHttpRequest | null = null;

  constructor(
    private app: App,
    private chain: WatcherChain,
    private settings: RankigiWatcherSettings
  ) {}

  start(): void {
    if (this.running) return;
    if (!this.settings.monitorNetwork) return;
    this.running = true;

    this.domainAllowlist = buildDomainAllowlist(this.app);

    // 1. window.fetch
    const win = (globalThis as unknown as { window?: Window }).window
      ?? (globalThis as unknown as Window);
    const winRecord = win as unknown as { fetch: FetchFn };
    if (typeof winRecord.fetch === "function") {
      this.origFetch = winRecord.fetch.bind(win);
      const wrapped: FetchFn = (input, init) =>
        this.wrappedFetch(input, init);
      this.wrappedFetchRef = wrapped;
      winRecord.fetch = wrapped;
    }

    // 2. XMLHttpRequest
    const xhrCtor = (globalThis as unknown as {
      XMLHttpRequest?: typeof XMLHttpRequest;
    }).XMLHttpRequest;
    if (xhrCtor) {
      this.xhrCtor = xhrCtor;
      this.origXhrOpen = xhrCtor.prototype.open;
      this.origXhrSend = xhrCtor.prototype.send;
      const self = this;
      const wrappedOpen: XhrOpenFn = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null
      ): void {
        const meta = this as unknown as XhrMeta;
        const urlStr = url instanceof URL ? url.href : url;
        meta._rw_method = method ? method.toUpperCase() : "GET";
        meta._rw_url = urlStr;
        if (self.isSelfTraffic(urlStr)) {
          meta._rw_skip = true;
        }
        return (self.origXhrOpen as XhrOpenFn).call(
          this,
          method,
          url,
          async ?? true,
          username,
          password
        );
      };
      const wrappedSend: XhrSendFn = function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null
      ): void {
        const meta = this as unknown as XhrMeta;
        if (!meta._rw_skip) {
          self.recordXhr(meta);
        }
        return (self.origXhrSend as XhrSendFn).call(this, body);
      };
      this.wrappedXhrOpenRef = wrappedOpen;
      this.wrappedXhrSendRef = wrappedSend;
      xhrCtor.prototype.open = wrappedOpen;
      xhrCtor.prototype.send = wrappedSend;
    }

    // 3. requestUrl via Object.defineProperty
    const winReq = (globalThis as unknown as {
      window?: { require?: (m: string) => unknown };
    }).window;
    const requireFn =
      winReq && typeof winReq.require === "function"
        ? winReq.require
        : (globalThis as unknown as { require?: (m: string) => unknown })
            .require;
    if (typeof requireFn === "function") {
      try {
        const mod = requireFn("obsidian") as ObsidianModule;
        if (mod && typeof mod === "object") {
          this.obsModule = mod;
          this.origRequestUrl = mod.requestUrl;
          const self = this;
          Object.defineProperty(mod, "requestUrl", {
            configurable: true,
            get() {
              return (param: unknown) => self.wrappedRequestUrl(param);
            },
            set(v) {
              self.queueAppend({
                category: "NETWORK",
                plugin_id: null,
                summary: "requestUrl binding reassigned",
                payload: {
                  event: "tamper_detected",
                  target: "requestUrl",
                },
                severity: "warn",
              });
              self.origRequestUrl = v;
            },
          });
        }
      } catch {
        // obsidian module not resolvable; leave requestUrl unpatched
      }
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Restore fetch
    const win = (globalThis as unknown as { window?: Window }).window
      ?? (globalThis as unknown as Window);
    const winRecord = win as unknown as { fetch: FetchFn };
    if (
      this.origFetch &&
      this.wrappedFetchRef &&
      winRecord.fetch === this.wrappedFetchRef
    ) {
      winRecord.fetch = this.origFetch;
    }
    this.origFetch = null;
    this.wrappedFetchRef = null;

    // Restore XHR
    if (this.xhrCtor && this.origXhrOpen && this.origXhrSend) {
      if (this.xhrCtor.prototype.open === this.wrappedXhrOpenRef) {
        this.xhrCtor.prototype.open = this.origXhrOpen;
      }
      if (this.xhrCtor.prototype.send === this.wrappedXhrSendRef) {
        this.xhrCtor.prototype.send = this.origXhrSend;
      }
    }
    this.origXhrOpen = null;
    this.origXhrSend = null;
    this.wrappedXhrOpenRef = null;
    this.wrappedXhrSendRef = null;
    this.xhrCtor = null;

    // Restore requestUrl as a plain data property
    if (this.obsModule) {
      try {
        Object.defineProperty(this.obsModule, "requestUrl", {
          configurable: true,
          writable: true,
          enumerable: true,
          value: this.origRequestUrl,
        });
      } catch {
        // ignore restore failure
      }
    }
    this.obsModule = null;
    this.origRequestUrl = null;
  }

  refreshAllowlist(): void {
    this.domainAllowlist = buildDomainAllowlist(this.app);
  }

  pendingFlushed(): Promise<void> {
    return this.pendingChain.then(() => undefined);
  }

  private isSelfTraffic(url: string): boolean {
    try {
      const host = new URL(url).host;
      const endpoint = new URL(this.settings.cloudEndpoint).host;
      return host === endpoint;
    } catch {
      return false;
    }
  }

  private isAllowedDomain(url: string): boolean {
    try {
      return this.domainAllowlist.has(new URL(url).host);
    } catch {
      return false;
    }
  }

  private queueAppend(params: {
    category: "NETWORK";
    plugin_id: string | null;
    summary: string;
    payload: Record<string, unknown>;
    severity: "info" | "warn" | "critical";
  }): void {
    const p = this.chain.append(params).catch(() => undefined);
    this.pendingChain = this.pendingChain.then(() => p);
  }

  private async wrappedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    try {
      const url = extractFetchUrl(input);
      const method = extractFetchMethod(input, init);

      if (this.isSelfTraffic(url)) {
        return (this.origFetch as FetchFn)(input, init);
      }
      if (hasSelfHeader(init)) {
        return (this.origFetch as FetchFn)(input, init);
      }

      const stack = new Error().stack ?? "";
      const plugin_id = resolvePluginFromStack(stack, this.app);
      const isUnknownDomain = !this.isAllowedDomain(url);

      let host = "";
      let pathname = "";
      try {
        const parsed = new URL(url);
        host = parsed.host;
        pathname = parsed.pathname;
      } catch {
        host = url;
      }

      this.queueAppend({
        category: "NETWORK",
        plugin_id,
        summary: method + " " + host + pathname,
        payload: {
          event: "fetch",
          url,
          method,
          host,
          unknown_domain: isUnknownDomain,
          stack_top: stack.split("\n")[1]?.trim() ?? null,
        },
        severity: isUnknownDomain ? "warn" : "info",
      });
    } catch {
      // never throw from a wrapper
    }
    return (this.origFetch as FetchFn)(input, init);
  }

  private recordXhr(meta: XhrMeta): void {
    try {
      const url = meta._rw_url ?? "";
      const method = meta._rw_method ?? "GET";
      const stack = new Error().stack ?? "";
      const plugin_id = resolvePluginFromStack(stack, this.app);
      const isUnknownDomain = !this.isAllowedDomain(url);

      let host = "";
      let pathname = "";
      try {
        const parsed = new URL(url);
        host = parsed.host;
        pathname = parsed.pathname;
      } catch {
        host = url;
      }

      this.queueAppend({
        category: "NETWORK",
        plugin_id,
        summary: method + " " + host + pathname,
        payload: {
          event: "xhr",
          url,
          method,
          host,
          unknown_domain: isUnknownDomain,
          stack_top: stack.split("\n")[1]?.trim() ?? null,
        },
        severity: isUnknownDomain ? "warn" : "info",
      });
    } catch {
      // never throw from a wrapper
    }
  }

  private async wrappedRequestUrl(param: unknown): Promise<unknown> {
    let url = "";
    if (typeof param === "string") {
      url = param;
    } else if (param && typeof param === "object") {
      const u = urlString((param as RequestUrlParamLike).url);
      if (u) url = u;
    }
    const method =
      param && typeof param === "object"
        ? (param as RequestUrlParamLike).method?.toUpperCase() ?? "GET"
        : "GET";

    const forward = (): unknown => {
      const orig = this.origRequestUrl;
      if (typeof orig !== "function") {
        throw new Error("requestUrl is not callable");
      }
      return (orig as (p: unknown) => unknown)(param);
    };

    try {
      if (url && this.isSelfTraffic(url)) {
        return await Promise.resolve(forward());
      }

      const stack = new Error().stack ?? "";
      const plugin_id = resolvePluginFromStack(stack, this.app);
      const isUnknownDomain = url ? !this.isAllowedDomain(url) : true;

      let host = "";
      let pathname = "";
      if (url) {
        try {
          const parsed = new URL(url);
          host = parsed.host;
          pathname = parsed.pathname;
        } catch {
          host = url;
        }
      }

      this.queueAppend({
        category: "NETWORK",
        plugin_id,
        summary: method + " " + host + pathname,
        payload: {
          event: "requestUrl",
          url,
          method,
          host,
          unknown_domain: isUnknownDomain,
          stack_top: stack.split("\n")[1]?.trim() ?? null,
        },
        severity: isUnknownDomain ? "warn" : "info",
      });
    } catch {
      // never throw from a wrapper
    }
    return Promise.resolve(forward());
  }
}
