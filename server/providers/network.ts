import { HttpsProxyAgent } from "https-proxy-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
// Keep the managed environment's proxy and CA trust; never disable TLS checks.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
  setGlobalDispatcher(new EnvHttpProxyAgent());
export const providerAgent = () => {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
};
