import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

let proxyConfigured = false;

/**
 * Configure all backend fetch calls to respect the proxy environment passed
 * by the desktop shell. The proxy address itself is deliberately never logged.
 */
export function configureGlobalProxy(): boolean {
  if (proxyConfigured) {
    return true;
  }

  const proxyUrl =
    process.env["HTTPS_PROXY"]?.trim() ||
    process.env["https_proxy"]?.trim() ||
    process.env["HTTP_PROXY"]?.trim() ||
    process.env["http_proxy"]?.trim();

  if (!proxyUrl) {
    return false;
  }

  const dispatcher = new EnvHttpProxyAgent();
  setGlobalDispatcher(dispatcher);
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
  proxyConfigured = true;
  return true;
}
